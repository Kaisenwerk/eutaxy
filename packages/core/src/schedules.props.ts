/**
 * The enumeration model's claims. v0.8's gate needs the first two PROVEN:
 * the number of schedules is the product of the choices, and no schedule
 * repeats; every schedule is also in bounds. Their proofs, which need
 * induction, are supplied in schedules.props.lean and checked by Lean's
 * kernel. That the schedules come in depth-first order is held here at
 * TESTED, and exactly, on every tree up to a bound, by engine's test of
 * the enumerator against this model. Each claim is about every list of
 * levels; the sample only keeps the TESTED rung's draws small (every
 * schedule of sixteen levels of sixteen options would not fit in memory).
 */

import { forall } from "@eutaxy/spec";
import { ascending, noRepeats, scheduleCount, schedules, withinLevels } from "./schedules.ts";

export const countIsProduct = forall(schedules, {
  sample: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => schedules(levels).length === scheduleCount(levels),
});

export const noRepeat = forall(schedules, {
  sample: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => noRepeats(schedules(levels)),
});

export const inBounds = forall(schedules, {
  sample: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => schedules(levels).every((s) => withinLevels(s, levels)),
});

export const depthFirstOrder = forall(schedules, {
  sample: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => ascending(schedules(levels)),
});
