/**
 * Eutaxy's own invariant checkers against naive reference implementations,
 * written here as directly as the invariants read in the design, with no
 * code shared with the checkers. `eutaxy report packages/core/src` runs
 * them; v0.8's gate needs each at CHECKED or better.
 */

import { forall } from "@eutaxy/spec";
import {
  anchored,
  atLeastOnceMissing,
  atMostOnceDuplicate,
  conditionOf,
  type DrawnCondition,
  type DrawnEffect,
  type DrawnSelector,
  type DrawnSnapshot,
  everyRowFailing,
  impliesMissing,
  type Pick,
  referencesOrphans,
  rowOf,
  targetOf,
  uniqueShared,
} from "./self-check.ts";

const selected = (e: DrawnEffect, s: DrawnSelector): boolean =>
  e.target === s.target &&
  (s.op === null || e.op === s.op) &&
  (s.kind === null || e.kind === s.kind) &&
  (s.status === null || e.status === s.status);

/** The first effect, in order, whose key an earlier selected effect already had; with that earlier one. */
function referenceDuplicate(effects: readonly DrawnEffect[], s: DrawnSelector) {
  for (let j = 0; j < effects.length; j++) {
    const b = effects[j] as DrawnEffect;
    if (!selected(b, s) || b.key === null) continue;
    for (let i = 0; i < j; i++) {
      const a = effects[i] as DrawnEffect;
      if (selected(a, s) && a.key !== null && a.key === b.key)
        return { key: JSON.stringify(b.key), first: i, second: j };
    }
  }
  return null;
}

export const atMostOnceMatchesReference = forall(atMostOnceDuplicate, {
  // The anchor is any effect's index; past the end it cycles.
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask) =>
    JSON.stringify(atMostOnceDuplicate(effects, at, mask)) ===
    JSON.stringify(referenceDuplicate(effects, anchored(effects, at, mask))),
});

/** Every expected key, in order and with repeats, that no selected effect carries. */
function referenceMissing(
  effects: readonly DrawnEffect[],
  s: DrawnSelector,
  expected: readonly ("1" | 1 | "b")[],
): string[] {
  return expected
    .filter((k) => !effects.some((e) => selected(e, s) && e.key === k))
    .map((k) => JSON.stringify(k));
}

export const atLeastOnceMatchesReference = forall(atLeastOnceMissing, {
  // The anchor is any effect's index; past the end it cycles.
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask, expected) =>
    JSON.stringify(atLeastOnceMissing(effects, at, mask, expected)) ===
    JSON.stringify(referenceMissing(effects, anchored(effects, at, mask), expected)),
});

// State invariants. A row's key is its JSON with the columns sorted; the values here are strings,
// numbers and null, so === is JSON equality.

type Value = string | number | null;
type Row = { readonly [column: string]: Value };

function canonical(v: Value | Row): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** The rows of a table in the last snapshot of the target; undefined when it has none. */
function lastRows(snapshots: readonly DrawnSnapshot[], pick: Pick, table: "t" | "u") {
  const target = targetOf(snapshots, pick);
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i] as DrawnSnapshot;
    if (s.target === target) return s[table].map((r) => rowOf(r) as Row);
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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const filtered = (where: DrawnCondition | null) => (r: Row) => where === null || holds(r, where);

export const everyRowMatchesReference = forall(everyRowFailing, {
  ensures: (snapshots, target, where, conditions) => {
    const rows = lastRows(snapshots, target, "t");
    let expected: string[] | null = [];
    if (rows !== undefined) {
      const failing = rows
        .filter(filtered(where))
        .filter((r) => !conditions.every((c) => holds(r, c)));
      expected = failing.length === 0 ? null : failing.map(canonical);
    }
    return same(everyRowFailing(snapshots, target, where, conditions), expected);
  },
});

export const uniqueMatchesReference = forall(uniqueShared, {
  ensures: (snapshots, target, where, path) => {
    const rows = lastRows(snapshots, target, "t");
    let expected: string[] | null = [];
    if (rows !== undefined) {
      const values = rows
        .filter(filtered(where))
        .filter((r) => path in r && r[path] !== null)
        .map((r) => canonical(r[path] as Value));
      const shared = values.filter(
        (v, i) => values.indexOf(v) === i && values.lastIndexOf(v) !== i,
      );
      expected = shared.length === 0 ? null : shared;
    }
    return same(uniqueShared(snapshots, target, where, path), expected);
  },
});

export const impliesMatchesReference = forall(impliesMissing, {
  when: (_effects, at) => Number.isInteger(at) && at >= 0,
  ensures: (effects, at, mask, snapshots, target, column) => {
    const rows = lastRows(snapshots, target, "t");
    let expected: string[] | null = [];
    if (rows !== undefined) {
      const present = rows.filter((r) => column in r).map((r) => canonical(r[column] as Value));
      const s = anchored(effects, at, mask);
      const missing: string[] = [];
      for (const e of effects) {
        if (!selected(e, s) || e.key === null) continue;
        const k = canonical(e.key);
        if (!present.includes(k) && !missing.includes(k)) missing.push(k);
      }
      expected = missing.length === 0 ? null : missing;
    }
    return same(impliesMissing(effects, at, mask, snapshots, target, column), expected);
  },
});

export const referencesMatchesReference = forall(referencesOrphans, {
  ensures: (snapshots, target, where, path, inTarget, column) => {
    const rows = lastRows(snapshots, target, "t");
    const named = lastRows(snapshots, inTarget, "u");
    let expected: string[] | null = [];
    if (rows !== undefined && named !== undefined) {
      const pointedAt = named
        .filter((r) => column in r && r[column] !== null)
        .map((r) => canonical(r[column] as Value));
      const orphans: string[] = [];
      for (const r of rows.filter(filtered(where))) {
        if (!(path in r) || r[path] === null) continue;
        const k = canonical(r[path] as Value);
        if (!pointedAt.includes(k) && !orphans.includes(k)) orphans.push(k);
      }
      expected = orphans.length === 0 ? null : orphans;
    }
    return same(referencesOrphans(snapshots, target, where, path, inTarget, column), expected);
  },
});
