/**
 * The D1 binding proxy. Every statement execution is an effect point: the
 * engine decides the fault, the real Miniflare-backed D1 performs the query,
 * and the log records call, result and fault in the documented shape. When
 * a Durable Object is the caller, the query leaves it behind its output
 * gate (`outboundGate`).
 */

import { canonicalJson, type JsonValue, readFaults, toJson, writeFaults } from "@eutaxy/core";
import { outboundGate, type ProxyContext, pointAt as point } from "./proxy-context.ts";

/** Whether a binding is a D1 database (what the proxies and the differential wrap). */
export function isD1(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function" &&
    typeof (value as { batch?: unknown }).batch === "function"
  );
}

export type { ProxyContext } from "./proxy-context.ts";

function metaOf(result: D1Result<unknown>): JsonValue {
  return { changes: result.meta.changes ?? 0, lastRowId: result.meta.last_row_id ?? null };
}

class StatementProxy {
  private readonly real: D1PreparedStatement;
  private readonly target: string;
  private readonly ctx: ProxyContext;
  readonly sql: string;
  readonly params: readonly unknown[];

  constructor(
    real: D1PreparedStatement,
    target: string,
    ctx: ProxyContext,
    sql: string,
    params: readonly unknown[],
  ) {
    this.real = real;
    this.target = target;
    this.ctx = ctx;
    this.sql = sql;
    this.params = params;
  }

  /** The real statement, for `batch()`. */
  get statement(): D1PreparedStatement {
    return this.real;
  }

  private args(): JsonValue {
    return { sql: this.sql, params: toJson(this.params) };
  }

  bind(...values: unknown[]): StatementProxy {
    return new StatementProxy(this.real.bind(...values), this.target, this.ctx, this.sql, values);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.ctx.hooks.effect(
      point(this.ctx, this.target, "run", this.args(), writeFaults),
      outboundGate(this.ctx, () => this.real.run<T>()),
      (r) => metaOf(r),
    );
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.ctx.hooks.effect(
      point(this.ctx, this.target, "all", this.args(), readFaults),
      outboundGate(this.ctx, () => this.real.all<T>()),
      (r) => ({ rows: r.results.length, changes: r.meta.changes ?? 0 }),
    );
  }

  first<T = unknown>(colName?: string): Promise<T | null> {
    return this.ctx.hooks.effect(
      point(
        this.ctx,
        this.target,
        "first",
        { ...(this.args() as object), column: colName ?? null } as JsonValue,
        readFaults,
      ),
      outboundGate(this.ctx, () =>
        colName === undefined ? this.real.first<T>() : this.real.first<T>(colName),
      ),
      (r) => ({ row: toJson(r) }),
    );
  }

  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    return this.ctx.hooks.effect(
      point(this.ctx, this.target, "raw", this.args(), readFaults),
      outboundGate(
        this.ctx,
        () =>
          (options
            ? this.real.raw<T>(options as { columnNames: true })
            : this.real.raw<T>()) as Promise<T[]>,
      ),
      (r) => ({ rows: r.length }),
    );
  }
}

/** Wrap a D1 binding. Methods not modelled fall through to the real binding and mark the run unsupported. */
export function proxyD1(real: D1Database, binding: string, ctx: ProxyContext): D1Database {
  const target = `D1:${binding}`;
  const modelled = {
    prepare(sql: string): StatementProxy {
      return new StatementProxy(real.prepare(sql), target, ctx, sql, []);
    },
    batch<T = Record<string, unknown>>(
      statements: readonly (StatementProxy | D1PreparedStatement)[],
    ): Promise<D1Result<T>[]> {
      const unwrapped = statements.map((s) => (s instanceof StatementProxy ? s.statement : s));
      const args = {
        statements: statements.map((s) =>
          s instanceof StatementProxy
            ? { sql: s.sql, params: toJson(s.params) }
            : "<unproxied statement>",
        ),
      };
      return ctx.hooks.effect(
        point(ctx, target, "batch", args, writeFaults),
        outboundGate(ctx, () => real.batch<T>(unwrapped as D1PreparedStatement[])),
        (rs) => ({
          changes: rs.reduce((n, r) => n + (r.meta.changes ?? 0), 0),
          statements: rs.length,
        }),
      );
    },
    exec(sql: string): Promise<D1ExecResult> {
      return ctx.hooks.effect(
        point(ctx, target, "exec", { sql }, writeFaults),
        outboundGate(ctx, () => real.exec(sql)),
        (r) => ({ count: r.count, duration: 0 }),
      );
    },
  };
  return new Proxy(real, {
    get(obj, prop, receiver) {
      if (prop in modelled) return modelled[prop as keyof typeof modelled];
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value === "function") {
        ctx.hooks.unsupported(`D1 ${binding}.${String(prop)} is not modelled`);
        return (value as (...a: unknown[]) => unknown).bind(obj);
      }
      return value;
    },
  }) as D1Database;
}

/**
 * Statements in a schema file. Splits on semicolons outside string literals,
 * quoted identifiers and comments, and keeps CREATE TRIGGER bodies (and CASE
 * expressions) whole by tracking BEGIN/CASE ... END nesting.
 */
export function splitSql(sql: string): readonly string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      // A comment separates the tokens around it (`CREATE/* c */TABLE`), as whitespace would.
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k === -1) {
          j = sql.length;
          break;
        }
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2; // a doubled quote inside the literal
          continue;
        }
        j = k + 1;
        break;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (isWordChar(c) && !isWordChar(sql[i - 1])) {
      let j = i;
      while (isWordChar(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === "BEGIN" || upper === "CASE") depth++;
      else if (upper === "END" && depth > 0) depth--;
      cur += word;
      i = j;
      continue;
    }
    if (c === ";" && depth === 0) {
      const statement = cur.trim();
      if (statement.length > 0) out.push(statement);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  const last = cur.trim();
  if (last.length > 0) out.push(last);
  return out;
}

/** Drop every user table and re-apply the schema, using the real binding (not an effect). */
export async function resetD1(real: D1Database, schema: string): Promise<void> {
  const tables = await real
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  // Children before parents: dropping a table deletes its rows first, which SQLite's foreign key checks
  // refuse while another table's rows still reference them, and a child whose parent is already gone
  // cannot be dropped at all. Each table's parents come from PRAGMA foreign_key_list.
  const quote = (n: string): string => `"${n.replace(/"/g, '""')}"`;
  // Triggers first: a trigger on a table being emptied or dropped can name a table already dropped,
  // which SQLite resolves even when no row fires it.
  const triggers = await real
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all<{ name: string }>();
  for (const { name } of triggers.results)
    await real.prepare(`DROP TRIGGER IF EXISTS ${quote(name)}`).run();
  const parents = new Map<string, Set<string>>();
  for (const { name } of tables.results) {
    const keys = await real
      .prepare(`PRAGMA foreign_key_list(${quote(name)})`)
      .all<{ table: string }>();
    parents.set(name, new Set(keys.results.map((k) => k.table).filter((t) => t !== name)));
  }
  const left = new Set(parents.keys());
  for (;;) {
    // A table no remaining table references is a leaf: dropped now.
    const leaves = [...left].filter((t) => ![...left].some((o) => parents.get(o)?.has(t)));
    if (leaves.length === 0) break;
    for (const t of leaves) {
      await real.prepare(`DROP TABLE IF EXISTS ${quote(t)}`).run();
      left.delete(t);
    }
  }
  if (left.size > 0) {
    // Tables that reference each other in a cycle: emptied in one transaction with the checks deferred
    // to its end, when nothing references anything, then dropped.
    const cycle = [...left];
    await real.batch([
      real.prepare("PRAGMA defer_foreign_keys = on"),
      ...cycle.map((t) => real.prepare(`DELETE FROM ${quote(t)}`)),
    ]);
    await real.batch([
      real.prepare("PRAGMA defer_foreign_keys = on"),
      ...cycle.map((t) => real.prepare(`DROP TABLE IF EXISTS ${quote(t)}`)),
    ]);
  }
  for (const statement of splitSql(schema)) {
    await real.prepare(statement).run();
  }
}

/** Every user table's rows, sorted canonically, read through the real binding (not an effect). */
export async function snapshotD1(
  real: D1Database,
): Promise<{ readonly [table: string]: readonly JsonValue[] }> {
  const tables = await real
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all<{ name: string }>();
  const out: Record<string, JsonValue[]> = {};
  for (const { name } of tables.results) {
    const rows = await real
      .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
      .all<Record<string, unknown>>();
    out[name] = rows.results
      .map((r) => toJson(r))
      .map((j) => [canonicalJson(j), j] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, j]) => j);
  }
  return out;
}
