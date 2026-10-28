/**
 * The invariant checkers as functions of plain data, for Eutaxy's own spec
 * file beside this one (`self-check.props.ts`): each builds an effect log
 * from drawn data, runs the real checker on it, and returns what the
 * checker found, its keys and its evidence. The spec file states, for
 * every one, that it agrees with a naive reference implementation. Not
 * exported from the package and never bundled: `eutaxy report
 * packages/core/src` reads it.
 *
 * The domains are small on purpose (two targets, two ops, three keys), so
 * drawn data collides on target, op and key as real logs do.
 */

import type { JsonValue } from "./canonical-json.ts";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import { checkInvariant, type Violation } from "./invariants.ts";
import type { EffectSelector } from "./selectors.ts";
import { type Row, type RowCondition, rowMatches } from "./state.ts";

/** A key as effects and rows carry it: "1" and 1 are different keys. */
export type Key = "1" | 1 | "b";

/** What a checker found: its keys and the sequence numbers of its evidence. Null when it holds. */
export interface Found {
  readonly keys: readonly string[];
  readonly evidence: readonly number[];
}

function found(v: Violation | null): Found | null {
  return v === null ? null : { keys: v.keys, evidence: v.evidence };
}

// Delivery invariants: effects selected by target, op, kind and payload fields.

/** One effect as drawn: what a selector and a delivery invariant read of it. */
export interface DrawnEffect {
  readonly kind: "call" | "result" | "fault";
  readonly target: "A" | "B";
  readonly op: "run" | "send";
  /** The payload's `key`; null leaves it out of the payload. */
  readonly key: Key | null;
  /** The payload's `status`, which a selector may require (`where`). */
  readonly status: "ok" | "err";
  /** The payload's `size`, which a selector may bound from below (`atLeast`). */
  readonly size: 0 | 1 | 2;
}

/** Which of an anchor effect's fields a selector requires besides its target, and a lower bound on size. */
export interface Mask {
  readonly op: boolean;
  readonly kind: boolean;
  readonly status: boolean;
  readonly minSize: 1 | 2 | null;
}

/** The parts of an effect selector the self-check varies; null leaves one out. */
export interface DrawnSelector {
  readonly target: "A" | "B";
  readonly op: "run" | "send" | null;
  readonly kind: "call" | "result" | "fault" | null;
  readonly status: "ok" | "err" | null;
  readonly minSize: 1 | 2 | null;
}

/**
 * The selector built from effect `at` (cycling; target A when there are
 * none): its target, and its op, kind and status where the mask says. A
 * selector drawn on its own would rarely select two effects with one key;
 * one anchored on a drawn effect selects at least that one (unless the
 * size bound excludes it).
 */
export function anchored(effects: readonly DrawnEffect[], at: number, mask: Mask): DrawnSelector {
  const e = effects.length === 0 ? undefined : effects[at % effects.length];
  return {
    target: e?.target ?? "A",
    op: e && mask.op ? e.op : null,
    kind: e && mask.kind ? e.kind : null,
    status: e && mask.status ? e.status : null,
    minSize: mask.minSize,
  };
}

function selector(s: DrawnSelector): EffectSelector {
  return {
    target: s.target,
    ...(s.op === null ? {} : { op: s.op }),
    ...(s.kind === null ? {} : { kind: s.kind }),
    ...(s.status === null ? {} : { where: { status: s.status } }),
    ...(s.minSize === null ? {} : { atLeast: { size: s.minSize } }),
  };
}

/** The effects as a log, one invocation, in order: effect i has sequence number i. */
export function logOf(effects: readonly DrawnEffect[]): EffectLog {
  let log = emptyLog;
  for (const e of effects) {
    const payload: { [k: string]: JsonValue } = { status: e.status, size: e.size };
    if (e.key !== null) payload["key"] = e.key;
    log = appendEffect(log, { kind: e.kind, invocation: "i", target: e.target, op: e.op, payload });
  }
  return log;
}

/** `atMostOncePerKey` on the drawn effects, selected as `anchored` says. */
export function atMostOnceDuplicate(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
): Found | null {
  return found(
    checkInvariant(logOf(effects), {
      kind: "atMostOncePerKey",
      name: "once",
      effect: selector(anchored(effects, at, mask)),
      key: "key",
    }),
  );
}

/** `atLeastOnce` on the drawn effects, selected as `anchored` says. */
export function atLeastOnceMissing(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
  expected: readonly Key[],
): Found | null {
  return found(
    checkInvariant(logOf(effects), {
      kind: "atLeastOnce",
      name: "atLeast",
      effect: selector(anchored(effects, at, mask)),
      key: "key",
      expected,
    }),
  );
}

// State invariants: rows in the last snapshot of a target.

/** One row as drawn: `id` may be absent or null, which the checkers tell apart; `tag` sits under `meta`. */
export interface DrawnRow {
  readonly id: Key | null | "absent";
  readonly n: 0 | 1 | 2;
  readonly ref: Key | null;
  readonly tag: Key | null;
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

/** A row as the snapshot holds it: `{ id?, n, ref, meta: { tag } }`. */
export function rowOf(r: DrawnRow): Row {
  return { ...(r.id === "absent" ? {} : { id: r.id }), n: r.n, ref: r.ref, meta: { tag: r.tag } };
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

/** Every drawn condition: each column, op and value. */
export const allConditions: readonly DrawnCondition[] = (["id", "n"] as const).flatMap((column) =>
  (["eq", "neq", "gt", "gte", "lt", "lte", "in", "notNull"] as const).flatMap((op) =>
    (["1", 1, "b", 0, 2, null] as const).map((value) => ({ column, op, value })),
  ),
);

/**
 * `rowMatches` on one drawn row against every condition in `allConditions`.
 * Inside an invariant a condition's answer is often masked by another's;
 * here each one is compared on its own.
 */
export function rowMatchesEach(row: DrawnRow): readonly boolean[] {
  return allConditions.map((c) => rowMatches(rowOf(row), conditionOf(c)));
}

/** The effects, then one snapshot effect per drawn snapshot: snapshot i has sequence number effects + i. */
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

/** A dot path into a row: a column, or the tag under `meta`. */
export type RowPath = "id" | "ref" | "meta.tag";

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

/** `everyRow` over table t of the target (`targetOf`), filtered by `where`. */
export function everyRowFailing(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  holds: readonly DrawnCondition[],
): Found | null {
  return found(
    checkInvariant(stateLog([], snapshots), {
      kind: "everyRow",
      name: "every",
      query: query(snapshots, target, "t", where),
      holds: holds.map(conditionOf),
    }),
  );
}

/** `unique` over table t of the target, filtered by `where`, at `path`. */
export function uniqueShared(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  path: RowPath,
): Found | null {
  return found(
    checkInvariant(stateLog([], snapshots), {
      kind: "unique",
      name: "unique",
      query: query(snapshots, target, "t", where),
      path,
    }),
  );
}

/** `implies`: every effect selected as `anchored` says has a row of t in the target, filtered by `where`, whose `column` is its key. */
export function impliesMissing(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  column: "id" | "ref",
): Found | null {
  return found(
    checkInvariant(stateLog(effects, snapshots), {
      kind: "implies",
      name: "implies",
      when: selector(anchored(effects, at, mask)),
      key: "key",
      state: query(snapshots, target, "t", where),
      column,
    }),
  );
}

/** `references`: every row of t in `target`, filtered by `where`, is named at `path` by the `column` of some row of u in `inTarget`. */
export function referencesOrphans(
  snapshots: readonly DrawnSnapshot[],
  target: Pick,
  where: DrawnCondition | null,
  path: RowPath,
  inTarget: Pick,
  column: "id" | "ref",
): Found | null {
  return found(
    checkInvariant(stateLog([], snapshots), {
      kind: "references",
      name: "references",
      query: query(snapshots, target, "t", where),
      path,
      in: query(snapshots, inTarget, "u", null),
      column,
    }),
  );
}

// refines: the shell follows its core's latest decision, and not on a stale read.

/** One step of a run: a decision (or one that threw), an action, a read or a write. */
export interface DrawnStep {
  readonly invocation: "x" | "y";
  readonly what: "decide" | "throws" | "act" | "read" | "write";
  /** The decision's result, the action's value, or the key read or written. */
  readonly value: Key;
}

/** The steps as a log, step i at sequence number i: decisions as `Core:decide` results, actions on Shell, reads and writes on Store. */
export function stepsLog(steps: readonly DrawnStep[]): EffectLog {
  let log = emptyLog;
  for (const s of steps) {
    const base = { invocation: s.invocation };
    switch (s.what) {
      case "decide":
      case "throws":
        log = appendEffect(log, {
          ...base,
          kind: "result",
          target: "Core:decide",
          op: "decide",
          payload:
            s.what === "decide" ? { args: [], result: s.value } : { args: [], error: "boom" },
        });
        break;
      case "act":
        log = appendEffect(log, {
          ...base,
          kind: "call",
          target: "Shell",
          op: "act",
          payload: { value: s.value },
        });
        break;
      case "read":
        log = appendEffect(log, {
          ...base,
          kind: "result",
          target: "Store",
          op: "read",
          payload: { key: s.value },
        });
        break;
      case "write":
        log = appendEffect(log, {
          ...base,
          kind: "call",
          target: "Store",
          op: "write",
          payload: { key: s.value },
        });
        break;
    }
  }
  return log;
}

/**
 * One invocation's shape, run in this order: its reads (none, one, or a
 * second that supersedes the first), its decisions (one that succeeds, one
 * that throws, either order of the two, two that succeed, or none), an
 * optional write, then the action. Random steps would rarely line up into
 * a read, a decision, another's write and an action.
 */
export interface DrawnInvocation {
  readonly reads: "none" | "once" | "twice";
  readonly readKey: Key;
  readonly rereadKey: Key;
  readonly decides: "ok" | "okThenThrows" | "throwsThenOk" | "twice" | "throws" | "none";
  readonly result: Key;
  /** The second decision's result, when there are two that succeed. */
  readonly second: Key;
  readonly writes: boolean;
  readonly writeKey: Key;
  /** The action's value: the first decision's result, the second's, or a key of its own. */
  readonly acts: "result" | "second" | Key;
}

/** The two invocations' steps, interleaved: each entry of `order` takes the next step of x or y; the rest follow, x first. */
export function stepsOf(
  x: DrawnInvocation,
  y: DrawnInvocation,
  order: readonly ("x" | "y")[],
): DrawnStep[] {
  const own = (inv: DrawnInvocation, invocation: "x" | "y"): DrawnStep[] => {
    const step = (what: DrawnStep["what"], value: Key): DrawnStep => ({ invocation, what, value });
    const d = inv.decides;
    return [
      ...(inv.reads === "none" ? [] : [step("read", inv.readKey)]),
      ...(inv.reads === "twice" ? [step("read", inv.rereadKey)] : []),
      ...(d === "throws" || d === "throwsThenOk" ? [step("throws", inv.result)] : []),
      ...(d === "ok" || d === "okThenThrows" || d === "throwsThenOk" || d === "twice"
        ? [step("decide", inv.result)]
        : []),
      ...(d === "twice" ? [step("decide", inv.second)] : []),
      ...(d === "okThenThrows" ? [step("throws", inv.result)] : []),
      ...(inv.writes ? [step("write", inv.writeKey)] : []),
      step(
        "act",
        inv.acts === "result" ? inv.result : inv.acts === "second" ? inv.second : inv.acts,
      ),
    ];
  };
  const queues = { x: own(x, "x"), y: own(y, "y") };
  const out: DrawnStep[] = [];
  for (const o of order) {
    const next = queues[o].shift();
    if (next) out.push(next);
  }
  return [...out, ...queues.x, ...queues.y];
}

/**
 * `refines` over the two invocations' steps (`stepsOf`): every action
 * follows its invocation's latest decision (its value the decision's
 * result, with `follows`), resting on its latest read before that
 * decision, which no other invocation's write (to the same key, with
 * `keyed`) overtook (with `state`).
 */
export function refinesViolation(
  x: DrawnInvocation,
  y: DrawnInvocation,
  order: readonly ("x" | "y")[],
  follows: boolean,
  state: boolean,
  keyed: boolean,
): Found | null {
  return found(
    checkInvariant(stepsLog(stepsOf(x, y, order)), {
      kind: "refines",
      name: "refines",
      decision: "decide",
      effect: { target: "Shell" },
      ...(follows ? { follows: [{ effect: "value", decision: "result" }] } : {}),
      ...(state
        ? {
            state: {
              read: { target: "Store", op: "read" },
              write: { target: "Store", op: "write" },
              ...(keyed ? { key: "key" } : {}),
            },
          }
        : {}),
    }),
  );
}

/** An invocation that reads (once or twice) and decides, as `refinesOnState` draws it: then an optional write, then the action. */
export interface DrawnReader {
  readonly readKey: Key;
  readonly rereads: boolean;
  readonly rereadKey: Key;
  readonly writes: boolean;
  readonly writeKey: Key;
}

/** The invocation shape a reader stands for. */
export function readerOf(r: DrawnReader): DrawnInvocation {
  return {
    reads: r.rereads ? "twice" : "once",
    readKey: r.readKey,
    rereadKey: r.rereadKey,
    decides: "ok",
    result: "1",
    second: "1",
    writes: r.writes,
    writeKey: r.writeKey,
    acts: "result",
  };
}

/** `refines` with only its state rule in play: both invocations read and decide, so what varies is who reads and writes what, and when. */
export function refinesOnState(
  x: DrawnReader,
  y: DrawnReader,
  order: readonly ("x" | "y")[],
  keyed: boolean,
): Found | null {
  return refinesViolation(readerOf(x), readerOf(y), order, true, true, keyed);
}
