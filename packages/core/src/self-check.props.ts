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
  type DrawnEffect,
  type DrawnSelector,
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
