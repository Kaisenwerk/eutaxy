/**
 * Eutaxy's own invariant checkers against naive reference implementations,
 * written here as directly as the invariants read in the design, with no
 * code shared with the checkers: each reference computes the keys and the
 * evidence (sequence numbers) a checker must report. `eutaxy report
 * packages/core/src` runs them; v0.8's gate needs each at CHECKED or better.
 */

import { forall } from "@eutaxy/spec";
import {
  allConditions,
  anchored,
  atLeastOnceMissing,
  atMostOnceDuplicate,
  conditionOf,
  type DrawnCondition,
  type DrawnEffect,
  type DrawnSelector,
  type DrawnSnapshot,
  type DrawnStep,
  everyRowFailing,
  impliesMissing,
  type Key,
  type Pick,
  type RowPath,
  readerOf,
  referencesOrphans,
  refinesOnState,
  refinesViolation,
  rowMatchesEach,
  rowOf,
  stepsOf,
  targetOf,
  uniqueShared,
} from "./self-check.ts";

type Found = { keys: string[]; evidence: number[] } | null;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** JSON with every object's keys sorted, at any depth. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}

// Delivery invariants.

const selected = (e: DrawnEffect, s: DrawnSelector): boolean =>
  e.target === s.target &&
  (s.op === null || e.op === s.op) &&
  (s.kind === null || e.kind === s.kind) &&
  (s.status === null || e.status === s.status) &&
  (s.minSize === null || e.size >= s.minSize);

/** The first effect, in order, whose key an earlier selected effect already had; with that earlier one. */
function referenceDuplicate(effects: readonly DrawnEffect[], s: DrawnSelector): Found {
  for (let j = 0; j < effects.length; j++) {
    const b = effects[j] as DrawnEffect;
    if (!selected(b, s) || b.key === null) continue;
    for (let i = 0; i < j; i++) {
      const a = effects[i] as DrawnEffect;
      if (selected(a, s) && a.key === b.key) return { keys: [canonical(b.key)], evidence: [i, j] };
    }
  }
  return null;
}

export const atMostOnceMatchesReference = forall(atMostOnceDuplicate, {
  // The anchor is any effect's index; past the end it cycles.
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask) =>
    same(
      atMostOnceDuplicate(effects, at, mask),
      referenceDuplicate(effects, anchored(effects, at, mask)),
    ),
});

/** Every expected key, in order and with repeats, that no selected effect carries; every selected effect as evidence. */
function referenceMissing(
  effects: readonly DrawnEffect[],
  s: DrawnSelector,
  expected: readonly Key[],
): Found {
  const missing = expected.filter((k) => !effects.some((e) => selected(e, s) && e.key === k));
  if (missing.length === 0) return null;
  const evidence = effects.flatMap((e, i) => (selected(e, s) ? [i] : []));
  return { keys: missing.map(canonical), evidence };
}

export const atLeastOnceMatchesReference = forall(atLeastOnceMissing, {
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask, expected) =>
    same(
      atLeastOnceMissing(effects, at, mask, expected),
      referenceMissing(effects, anchored(effects, at, mask), expected),
    ),
});

// State invariants. Values are strings, numbers, null and the `meta` record: === compares the
// scalars, `canonical` the rows.

type Row = { readonly [column: string]: unknown };

/** The last snapshot of the target: its rows of the table and its sequence number (after `offset` effects). */
function lastSnapshot(
  snapshots: readonly DrawnSnapshot[],
  pick: Pick,
  table: "t" | "u",
  offset = 0,
): { rows: Row[]; seq: number } | undefined {
  const target = targetOf(snapshots, pick);
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i] as DrawnSnapshot;
    if (s.target === target) return { rows: s[table].map((r) => rowOf(r) as Row), seq: offset + i };
  }
  return undefined;
}

function holds(row: Row, drawn: DrawnCondition): boolean {
  const c = conditionOf(drawn);
  const has = c.column in row;
  const v = row[c.column];
  switch (c.op) {
    case "eq":
      return has && v === c.value;
    case "neq":
      return !has || v !== c.value;
    case "gt":
      return typeof v === "number" && v > c.value;
    case "gte":
      return typeof v === "number" && v >= c.value;
    case "lt":
      return typeof v === "number" && v < c.value;
    case "lte":
      return typeof v === "number" && v <= c.value;
    case "in":
      return has && c.value.some((x) => x === v);
    case "notNull":
      return has && v !== null;
  }
}

export const rowMatchesMatchesReference = forall(rowMatchesEach, {
  ensures: (row) =>
    same(
      rowMatchesEach(row),
      allConditions.map((c) => holds(rowOf(row) as Row, c)),
    ),
});

const kept = (where: DrawnCondition | null) => (r: Row) => where === null || holds(r, where);

/** The value at a row path: a column, or the tag under meta. */
function valueAt(row: Row, path: RowPath): unknown {
  return path === "meta.tag" ? (row["meta"] as { tag: unknown }).tag : row[path];
}

const noSnapshot: Found = { keys: [], evidence: [] };

export const everyRowMatchesReference = forall(everyRowFailing, {
  ensures: (snapshots, target, where, conditions) => {
    const s = lastSnapshot(snapshots, target, "t");
    let expected: Found = noSnapshot;
    if (s !== undefined) {
      const failing = s.rows
        .filter(kept(where))
        .filter((r) => !conditions.every((c) => holds(r, c)));
      expected = failing.length === 0 ? null : { keys: failing.map(canonical), evidence: [s.seq] };
    }
    return same(everyRowFailing(snapshots, target, where, conditions), expected);
  },
});

export const uniqueMatchesReference = forall(uniqueShared, {
  ensures: (snapshots, target, where, path) => {
    const s = lastSnapshot(snapshots, target, "t");
    let expected: Found = noSnapshot;
    if (s !== undefined) {
      const values = s.rows
        .filter(kept(where))
        .map((r) => valueAt(r, path))
        .filter((v) => v !== undefined && v !== null)
        .map(canonical);
      const shared = values.filter(
        (v, i) => values.indexOf(v) === i && values.lastIndexOf(v) !== i,
      );
      expected = shared.length === 0 ? null : { keys: shared, evidence: [s.seq] };
    }
    return same(uniqueShared(snapshots, target, where, path), expected);
  },
});

export const impliesMatchesReference = forall(impliesMissing, {
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask, snapshots, target, where, column) => {
    const s = lastSnapshot(snapshots, target, "t", effects.length);
    let expected: Found = noSnapshot;
    if (s !== undefined) {
      const present = s.rows
        .filter(kept(where))
        .filter((r) => column in r)
        .map((r) => canonical(r[column]));
      const sel = anchored(effects, at, mask);
      const missing: string[] = [];
      const evidence: number[] = [];
      effects.forEach((e, i) => {
        if (!selected(e, sel) || e.key === null) return;
        const k = canonical(e.key);
        if (present.includes(k)) return;
        if (!missing.includes(k)) missing.push(k);
        evidence.push(i);
      });
      expected = missing.length === 0 ? null : { keys: missing, evidence };
    }
    return same(impliesMissing(effects, at, mask, snapshots, target, where, column), expected);
  },
});

export const referencesMatchesReference = forall(referencesOrphans, {
  ensures: (snapshots, target, where, path, inTarget, column) => {
    const s = lastSnapshot(snapshots, target, "t");
    const named = lastSnapshot(snapshots, inTarget, "u");
    let expected: Found = noSnapshot;
    if (s !== undefined && named !== undefined) {
      const pointedAt = named.rows
        .filter((r) => column in r && r[column] !== null)
        .map((r) => canonical(r[column]));
      const orphans: string[] = [];
      for (const r of s.rows.filter(kept(where))) {
        const v = valueAt(r, path);
        if (v === undefined || v === null) continue;
        const k = canonical(v);
        if (!pointedAt.includes(k) && !orphans.includes(k)) orphans.push(k);
      }
      expected = orphans.length === 0 ? null : { keys: orphans, evidence: [s.seq, named.seq] };
    }
    return same(referencesOrphans(snapshots, target, where, path, inTarget, column), expected);
  },
});

// refines, step by step: for each action in order, its invocation's latest decision that did not
// throw, the latest read before that decision, and the first other invocation's write between the
// read and the action.

function latest(steps: readonly DrawnStep[], before: number, pick: (s: DrawnStep) => boolean) {
  for (let i = before - 1; i >= 0; i--) if (pick(steps[i] as DrawnStep)) return i;
  return -1;
}

function referenceRefines(
  steps: readonly DrawnStep[],
  follows: boolean,
  state: boolean,
  keyed: boolean,
): Found {
  for (let j = 0; j < steps.length; j++) {
    const act = steps[j] as DrawnStep;
    if (act.what !== "act") continue;
    const own = (s: DrawnStep) => s.invocation === act.invocation;
    // A decision that threw decided nothing; the latest one that did not is carried out.
    const d = latest(steps, j, (s) => own(s) && s.what === "decide");
    if (d < 0) return { keys: ["no_decision"], evidence: [j] };
    if (follows && (steps[d] as DrawnStep).value !== act.value)
      return { keys: ["not_followed", "value"], evidence: [d, j] };
    if (!state) continue;
    const r = latest(steps, d, (s) => own(s) && s.what === "read");
    if (r < 0) return { keys: ["no_read"], evidence: [d, j] };
    const read = steps[r] as DrawnStep;
    const w = steps.findIndex(
      (s, k) =>
        k > r &&
        k < j &&
        s.invocation !== act.invocation &&
        s.what === "write" &&
        (!keyed || s.value === read.value),
    );
    if (w >= 0)
      return {
        keys: ["stale_read", ...(keyed ? [canonical(read.value)] : [])],
        evidence: [r, d, w, j],
      };
  }
  return null;
}

export const refinesMatchesReference = forall(refinesViolation, {
  ensures: (x, y, order, follows, state, keyed) =>
    same(
      refinesViolation(x, y, order, follows, state, keyed),
      referenceRefines(stepsOf(x, y, order), follows, state, keyed),
    ),
});

export const refinesOnStateMatchesReference = forall(refinesOnState, {
  ensures: (x, y, order, keyed) =>
    same(
      refinesOnState(x, y, order, keyed),
      referenceRefines(stepsOf(readerOf(x), readerOf(y), order), true, true, keyed),
    ),
});
