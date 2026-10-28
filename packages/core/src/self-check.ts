/**
 * The invariant checkers as functions of plain data, for Eutaxy's own spec
 * file beside this one (`self-check.props.ts`): each builds an effect log
 * from drawn effects, runs the real checker on it, and returns what the
 * checker found. The spec file states, for every one, that it agrees with
 * a naive reference implementation. Not exported from the package and
 * never bundled: `eutaxy report packages/core/src` reads it.
 *
 * The domains are small on purpose (two targets, two ops, a few keys), so
 * drawn effects collide on target, op and key as real logs do.
 */

import type { JsonValue } from "./canonical-json.ts";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import { checkInvariant } from "./invariants.ts";
import type { Row, RowCondition } from "./state.ts";

/** One effect as drawn: what a delivery invariant reads of it. */
export interface DrawnEffect {
  readonly kind: "call" | "result" | "fault";
  readonly target: "A" | "B";
  readonly op: "run" | "send";
  /** The payload's `key`; null leaves it out of the payload. */
  readonly key: "1" | 1 | "b" | null;
  /** The payload's `status`, which a selector may require. */
  readonly status: "ok" | "err";
}

/** The parts of an effect selector the self-check varies; null leaves one out. */
export interface DrawnSelector {
  readonly target: "A" | "B";
  readonly op: "run" | "send" | null;
  readonly kind: "call" | "result" | "fault" | null;
  readonly status: "ok" | "err" | null;
}

/** Which of an anchor effect's fields a selector requires besides its target. */
export interface Mask {
  readonly op: boolean;
  readonly kind: boolean;
  readonly status: boolean;
}

/**
 * The selector built from effect `at` (cycling; target A when there are
 * none): its target, and its op, kind and status where the mask says. A
 * selector drawn on its own would rarely select two effects with one key;
 * one anchored on a drawn effect selects at least that one.
 */
export function anchored(effects: readonly DrawnEffect[], at: number, mask: Mask): DrawnSelector {
  const e = effects.length === 0 ? undefined : effects[at % effects.length];
  return {
    target: e?.target ?? "A",
    op: e && mask.op ? e.op : null,
    kind: e && mask.kind ? e.kind : null,
    status: e && mask.status ? e.status : null,
  };
}

/** A duplicate the checker reports: the key in canonical JSON and the two sequence numbers. */
export interface Duplicate {
  readonly key: string;
  readonly first: number;
  readonly second: number;
}

/** The effects as a log, one invocation, in order. */
export function logOf(effects: readonly DrawnEffect[]): EffectLog {
  let log = emptyLog;
  for (const e of effects) {
    const payload: { [k: string]: JsonValue } = { status: e.status };
    if (e.key !== null) payload["key"] = e.key;
    log = appendEffect(log, {
      kind: e.kind,
      invocation: "i",
      target: e.target,
      op: e.op,
      payload,
    });
  }
  return log;
}

function selector(s: DrawnSelector) {
  return {
    target: s.target,
    ...(s.op === null ? {} : { op: s.op }),
    ...(s.kind === null ? {} : { kind: s.kind }),
    ...(s.status === null ? {} : { where: { status: s.status } }),
  };
}

/** `atMostOncePerKey` on the drawn effects, selected as `anchored` says: the duplicate it reports, or null. */
export function atMostOnceDuplicate(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
): Duplicate | null {
  const v = checkInvariant(logOf(effects), {
    kind: "atMostOncePerKey",
    name: "once",
    effect: selector(anchored(effects, at, mask)),
    key: "key",
  });
  if (v === null) return null;
  return {
    key: v.keys[0] as string,
    first: v.evidence[0] as number,
    second: v.evidence[1] as number,
  };
}

/** `atLeastOnce` on the drawn effects, selected as `anchored` says: the expected keys it reports missing (canonical JSON); empty when it holds. */
export function atLeastOnceMissing(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
  expected: readonly ("1" | 1 | "b")[],
): readonly string[] {
  const v = checkInvariant(logOf(effects), {
    kind: "atLeastOnce",
    name: "atLeast",
    effect: selector(anchored(effects, at, mask)),
    key: "key",
    expected,
  });
  return v === null ? [] : v.keys;
}

// State invariants: rows in the last snapshot of a target.

/** A key as rows and effects carry it. */
export type Key = "1" | 1 | "b";

/** One row as drawn: `id` may be absent (`hasId` false) or null, which the checkers tell apart. */
export interface DrawnRow {
  readonly id: Key | null;
  readonly hasId: boolean;
  readonly n: 0 | 1 | 2;
  readonly ref: Key | null;
}

/** One end-of-run snapshot of a target: its tables `t` and `u`. */
export interface DrawnSnapshot {
  readonly target: "A" | "B";
  readonly t: readonly DrawnRow[];
  readonly u: readonly DrawnRow[];
}

/** A condition on a row as drawn; `conditionOf` makes the checkers' `RowCondition` of it. */
export interface DrawnCondition {
  readonly column: "id" | "n";
  readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notNull";
  readonly value: Key | 0 | 2 | null;
}

/** A row as the snapshot holds it. */
export function rowOf(r: DrawnRow): Row {
  return { ...(r.hasId ? { id: r.id } : {}), n: r.n, ref: r.ref };
}

/** The checkers' condition: ordering ops compare with a number (1 when the drawn value is none), `in` with the value and 2. */
export function conditionOf(c: DrawnCondition): RowCondition {
  switch (c.op) {
    case "eq":
    case "neq":
      return { column: c.column, op: c.op, value: c.value };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { column: c.column, op: c.op, value: typeof c.value === "number" ? c.value : 1 };
    case "in":
      return { column: c.column, op: "in", value: [c.value, 2] };
    case "notNull":
      return { column: c.column, op: "notNull" };
  }
}

/** The effects, then one snapshot effect per drawn snapshot, in order. */
export function stateLog(
  effects: readonly DrawnEffect[],
  snapshots: readonly DrawnSnapshot[],
): EffectLog {
  let log = logOf(effects);
  for (const s of snapshots)
    log = appendEffect(log, {
      kind: "snapshot",
      invocation: "end",
      target: s.target,
      op: "snapshot",
      payload: { tables: { t: s.t.map(rowOf), u: s.u.map(rowOf) } },
    });
  return log;
}

/**
 * Which snapshot target a query reads: "first" is the first snapshot's (A
 * when there are none), so most queries find a snapshot; A and B may not.
 */
export type Pick = "first" | "A" | "B";

export function targetOf(snapshots: readonly DrawnSnapshot[], pick: Pick): "A" | "B" {
  return pick === "first" ? (snapshots[0]?.target ?? "A") : pick;
}

const query = (
  snapshots: readonly DrawnSnapshot[],
  pick: Pick,
  table: "t" | "u",
  where: DrawnCondition | null,
) => ({
  target: targetOf(snapshots, pick),
  table,
  where: where === null ? [] : [conditionOf(where)],
});

/** `everyRow` over table t of the target (`targetOf`), filtered by `where`: the failing rows' keys, [] without a snapshot, null when it holds. */
export function everyRowFailing(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  holds: readonly DrawnCondition[],
): readonly string[] | null {
  const v = checkInvariant(stateLog([], snapshots), {
    kind: "everyRow",
    name: "every",
    query: query(snapshots, target, "t", where),
    holds: holds.map(conditionOf),
  });
  return v === null ? null : v.keys;
}

/** `unique` over table t of the target at `path`: the shared values, [] without a snapshot, null when it holds. */
export function uniqueShared(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  path: "id" | "ref",
): readonly string[] | null {
  const v = checkInvariant(stateLog([], snapshots), {
    kind: "unique",
    name: "unique",
    query: query(snapshots, target, "t", where),
    path,
  });
  return v === null ? null : v.keys;
}

/** `implies`: every effect selected as `anchored` says has a row of t in the target whose `column` is its key. */
export function impliesMissing(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  column: "id" | "ref",
): readonly string[] | null {
  const v = checkInvariant(stateLog(effects, snapshots), {
    kind: "implies",
    name: "implies",
    when: selector(anchored(effects, at, mask)),
    key: "key",
    state: query(snapshots, target, "t", null),
    column,
  });
  return v === null ? null : v.keys;
}

/** `references`: every row of t in `target` (as `where` filters) is named by some row of u in `inTarget`. */
export function referencesOrphans(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  path: "id" | "ref",
  inTarget: Pick,
  column: "id" | "ref",
): readonly string[] | null {
  const v = checkInvariant(stateLog([], snapshots), {
    kind: "references",
    name: "references",
    query: query(snapshots, target, "t", where),
    path,
    in: query(snapshots, inTarget, "u", null),
    column,
  });
  return v === null ? null : v.keys;
}
