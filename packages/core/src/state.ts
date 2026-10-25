/** State invariants: conditions on the rows of the end-of-run snapshots recorded in the log. */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { EffectLog, EffectRecord } from "./effect-log.ts";
import type { Violation } from "./invariants.ts";
import { type EffectSelector, getPath, jsonEqual, keyOf, selectEffects } from "./selectors.ts";

/** A condition on one column of a row. */
export type RowCondition =
  | { readonly column: string; readonly op: "eq" | "neq"; readonly value: JsonValue }
  | { readonly column: string; readonly op: "gt" | "gte" | "lt" | "lte"; readonly value: number }
  | { readonly column: string; readonly op: "in"; readonly value: readonly JsonValue[] }
  | { readonly column: string; readonly op: "notNull" };

/** Rows of a table in the last snapshot of a target, optionally filtered. */
export interface StateQuery {
  /** The snapshot target, e.g. "D1:DB". */
  readonly target: string;
  readonly table: string;
  readonly where?: readonly RowCondition[];
}

/** Every row the query returns satisfies all of `holds`. */
export interface EveryRow {
  readonly kind: "everyRow";
  readonly name: string;
  readonly query: StateQuery;
  readonly holds: readonly RowCondition[];
}

/**
 * For every selected effect, a row exists whose `column` equals the effect's
 * key. Ties what the shell did to what the state says, e.g. "every acked
 * message has its payment row".
 */
export interface Implies {
  readonly kind: "implies";
  readonly name: string;
  readonly when: EffectSelector;
  /** Dot path into the effect payload that yields the key. */
  readonly key: string;
  readonly state: StateQuery;
  readonly column: string;
}

/**
 * No two rows the query returns share the value at `path`, a dot path into
 * the row (a column name for flat rows). Rows where it is absent or null are
 * skipped. Catches a resource handed out twice, e.g. "no project holds two
 * slots".
 */
export interface Unique {
  readonly kind: "unique";
  readonly name: string;
  readonly query: StateQuery;
  readonly path: string;
}

export type Row = { readonly [column: string]: JsonValue };

/** The tables in the last snapshot recorded for a target, or undefined when none was. */
export function lastSnapshot(
  log: EffectLog,
  target: string,
): { readonly [table: string]: readonly Row[] } | undefined {
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const e = log.entries[i] as EffectRecord;
    if (e.kind === "snapshot" && e.target === target) {
      const tables = getPath(e.payload, "tables");
      if (tables && typeof tables === "object" && !Array.isArray(tables)) {
        return tables as { readonly [table: string]: readonly Row[] };
      }
      return {};
    }
  }
  return undefined;
}

export function rowMatches(row: Row, condition: RowCondition): boolean {
  const v = row[condition.column];
  switch (condition.op) {
    case "eq":
      return v !== undefined && jsonEqual(v, condition.value);
    case "neq":
      return v === undefined || !jsonEqual(v, condition.value);
    case "gt":
      return typeof v === "number" && v > condition.value;
    case "gte":
      return typeof v === "number" && v >= condition.value;
    case "lt":
      return typeof v === "number" && v < condition.value;
    case "lte":
      return typeof v === "number" && v <= condition.value;
    case "in":
      return v !== undefined && condition.value.some((c) => jsonEqual(v, c));
    case "notNull":
      return v !== undefined && v !== null;
  }
}

/** Rows a state query selects from the log's last snapshot; undefined when there is no snapshot. */
export function queryRows(log: EffectLog, query: StateQuery): readonly Row[] | undefined {
  const tables = lastSnapshot(log, query.target);
  if (!tables) return undefined;
  const rows = tables[query.table] ?? [];
  const where = query.where ?? [];
  return rows.filter((r) => where.every((c) => rowMatches(r, c)));
}

function snapshotSeq(log: EffectLog, target: string): number[] {
  let last: number | undefined;
  for (const e of log.entries) if (e.kind === "snapshot" && e.target === target) last = e.seq;
  return last === undefined ? [] : [last];
}

export function checkEveryRow(log: EffectLog, inv: EveryRow): Violation | null {
  const rows = queryRows(log, inv.query);
  if (rows === undefined) {
    return {
      invariant: inv.name,
      message: `no snapshot of ${inv.query.target} was recorded`,
      keys: [],
      evidence: [],
    };
  }
  const failing = rows.filter((r) => !inv.holds.every((c) => rowMatches(r, c)));
  if (failing.length === 0) return null;
  const keys = failing.map((r) => canonicalJson(r));
  const shown = keys.slice(0, 3).join(", ") + (failing.length > 3 ? ", …" : "");
  return {
    invariant: inv.name,
    message: `${failing.length} row(s) of ${inv.query.table} in ${inv.query.target} violate the condition: ${shown}`,
    keys,
    evidence: snapshotSeq(log, inv.query.target),
  };
}

export function checkUnique(log: EffectLog, inv: Unique): Violation | null {
  const rows = queryRows(log, inv.query);
  if (rows === undefined) {
    return {
      invariant: inv.name,
      message: `no snapshot of ${inv.query.target} was recorded`,
      keys: [],
      evidence: [],
    };
  }
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = getPath(r as JsonValue, inv.path);
    if (v === undefined || v === null) continue;
    const k = canonicalJson(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, n]) => n > 1);
  if (shared.length === 0) return null;
  const shown = shared.map(
    ([k, n]) => `${n} rows of ${inv.query.table} in ${inv.query.target} share ${inv.path} = ${k}`,
  );
  return {
    invariant: inv.name,
    message: shown.join("; "),
    keys: shared.map(([k]) => k),
    evidence: snapshotSeq(log, inv.query.target),
  };
}

export function checkImplies(log: EffectLog, inv: Implies): Violation | null {
  const rows = queryRows(log, inv.state);
  if (rows === undefined) {
    return {
      invariant: inv.name,
      message: `no snapshot of ${inv.state.target} was recorded`,
      keys: [],
      evidence: [],
    };
  }
  const present = new Set<string>();
  for (const r of rows) {
    const v = r[inv.column];
    if (v !== undefined) present.add(canonicalJson(v));
  }
  const missing: string[] = [];
  const evidence: number[] = [];
  for (const e of selectEffects(log, inv.when)) {
    const k = keyOf(e, inv.key);
    if (k === undefined || present.has(k)) continue;
    if (!missing.includes(k)) missing.push(k);
    evidence.push(e.seq);
  }
  if (missing.length === 0) return null;
  return {
    invariant: inv.name,
    message: `${inv.when.target} ${inv.when.op ?? "*"} happened for key(s) ${missing.join(", ")} but ${inv.state.table}.${inv.column} in ${inv.state.target} has no such row`,
    keys: missing,
    evidence,
  };
}
