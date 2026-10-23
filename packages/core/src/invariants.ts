/**
 * Invariants are plain data describing a property of the effect log; checkers
 * are pure functions from (log, invariant) to a violation or null. The
 * library starts with what the first planted bug needs and grows from there.
 */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { EffectKind, EffectLog, EffectRecord } from "./effect-log.ts";

/** Picks effect records by target, op, kind and payload fields. */
export interface EffectSelector {
  readonly target: string;
  readonly op?: string;
  readonly kind?: EffectKind;
  /** Dot paths into the payload that must equal the given values. */
  readonly where?: { readonly [path: string]: JsonValue };
  /** Dot paths into the payload whose numeric value must be at least the given bound. */
  readonly atLeast?: { readonly [path: string]: number };
}

/** No two selected effects share the same key. Catches duplicate writes. */
export interface AtMostOncePerKey {
  readonly kind: "atMostOncePerKey";
  readonly name: string;
  readonly effect: EffectSelector;
  /** Dot path into the payload that identifies the key. */
  readonly key: string;
}

/** Every expected key appears in at least one selected effect. Catches lost work. */
export interface AtLeastOnce {
  readonly kind: "atLeastOnce";
  readonly name: string;
  readonly effect: EffectSelector;
  readonly key: string;
  readonly expected: readonly JsonValue[];
  /** Set when `expected` was derived from the drive's message bodies, so it can be re-derived when messages are removed. */
  readonly perMessage?: { readonly bodyKey: string };
}

/** Re-derive `expected` for per-message invariants from the bodies that remain. */
export function recomputePerMessageExpected(
  invariants: readonly Invariant[],
  bodies: readonly JsonValue[],
): readonly Invariant[] {
  return invariants.map((inv) => {
    if (inv.kind !== "atLeastOnce" || !inv.perMessage) return inv;
    const bodyKey = inv.perMessage.bodyKey;
    const expected: JsonValue[] = [];
    for (const b of bodies) {
      const v = getPath(b, bodyKey);
      if (v !== undefined) expected.push(v);
    }
    return { ...inv, expected };
  });
}

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

export type Invariant = AtMostOncePerKey | AtLeastOnce | EveryRow | Implies | Unique;

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

export interface Violation {
  readonly invariant: string;
  readonly message: string;
  /** The keys involved, in canonical JSON, so two violations can be compared across runs. */
  readonly keys: readonly string[];
  /** Sequence numbers of the effects that witness the violation. */
  readonly evidence: readonly number[];
}

/** True when two violations are of the same invariant for the same keys, whatever the traces. */
export function sameViolation(a: Violation, b: Violation): boolean {
  return (
    a.invariant === b.invariant &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}

/** Read a dot path such as "args.params.0" out of JSON data; undefined when absent. */
export function getPath(value: JsonValue, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  if (path === "") return cur;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0) return undefined;
      cur = cur[i];
    } else {
      cur = (cur as { readonly [k: string]: JsonValue })[part];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i] as JsonValue));
  }
  const ao = a as { readonly [k: string]: JsonValue };
  const bo = b as { readonly [k: string]: JsonValue };
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i] && jsonEqual(ao[k], bo[k] as JsonValue))
  );
}

export function matches(record: EffectRecord, sel: EffectSelector): boolean {
  if (record.target !== sel.target) return false;
  if (sel.op !== undefined && record.op !== sel.op) return false;
  if (sel.kind !== undefined && record.kind !== sel.kind) return false;
  if (sel.where) {
    for (const [path, want] of Object.entries(sel.where)) {
      if (!jsonEqual(getPath(record.payload, path), want)) return false;
    }
  }
  if (sel.atLeast) {
    for (const [path, min] of Object.entries(sel.atLeast)) {
      const v = getPath(record.payload, path);
      if (typeof v !== "number" || v < min) return false;
    }
  }
  return true;
}

export function selectEffects(log: EffectLog, sel: EffectSelector): readonly EffectRecord[] {
  return log.entries.filter((e) => matches(e, sel));
}

/** Canonical form of a key, so equal JSON values compare equal whatever their key order. */
function keyOf(record: EffectRecord, path: string): string | undefined {
  const v = getPath(record.payload, path);
  return v === undefined ? undefined : canonicalJson(v);
}

export function checkInvariant(log: EffectLog, inv: Invariant): Violation | null {
  switch (inv.kind) {
    case "everyRow":
      return checkEveryRow(log, inv);
    case "implies":
      return checkImplies(log, inv);
    case "unique":
      return checkUnique(log, inv);
    case "atMostOncePerKey": {
      const seen = new Map<string, number>();
      for (const e of selectEffects(log, inv.effect)) {
        const k = keyOf(e, inv.key);
        if (k === undefined) continue;
        const first = seen.get(k);
        if (first !== undefined) {
          return {
            invariant: inv.name,
            message: `${inv.effect.target} ${inv.effect.op ?? "*"} happened twice for key ${k} (seq ${first} and ${e.seq})`,
            keys: [k],
            evidence: [first, e.seq],
          };
        }
        seen.set(k, e.seq);
      }
      return null;
    }
    case "atLeastOnce": {
      const present = new Set<string>();
      const selected = selectEffects(log, inv.effect);
      for (const e of selected) {
        const k = keyOf(e, inv.key);
        if (k !== undefined) present.add(k);
      }
      const missing = inv.expected.map((v) => canonicalJson(v)).filter((k) => !present.has(k));
      if (missing.length === 0) return null;
      return {
        invariant: inv.name,
        message: `${inv.effect.target} ${inv.effect.op ?? "*"} never happened for key(s) ${missing.join(", ")}`,
        keys: missing,
        evidence: selected.map((e) => e.seq),
      };
    }
  }
}

function checkEveryRow(log: EffectLog, inv: EveryRow): Violation | null {
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

function checkUnique(log: EffectLog, inv: Unique): Violation | null {
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

function checkImplies(log: EffectLog, inv: Implies): Violation | null {
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

export function checkInvariants(
  log: EffectLog,
  invariants: readonly Invariant[],
): readonly Violation[] {
  const out: Violation[] = [];
  for (const inv of invariants) {
    const v = checkInvariant(log, inv);
    if (v) out.push(v);
  }
  return out;
}
