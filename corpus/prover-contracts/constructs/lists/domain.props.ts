import { forall } from "@eutaxy/spec";
import { allBelow, doubled, hasAt, pushFront, scheduleCount, schedules, sum } from "./domain.ts";

// The enumeration model's count: needs induction, so the tactic script gives up on it.
export const countIsProduct = forall(schedules, {
  sample: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => schedules(levels).length === scheduleCount(levels),
});

export const emptyCount = forall(scheduleCount, {
  when: (levels) => levels.length === 0,
  ensures: (levels) => scheduleCount(levels) === 1,
});

export const doubledKeepsLength = forall(doubled, {
  ensures: (xs) => doubled(xs).length === xs.length,
});

export const pushFrontGrows = forall(pushFront, {
  ensures: (x, xs) => pushFront(x, xs).length === xs.length + 1,
});

export const sumOfOne = forall(sum, {
  when: (xs) => xs.length === 1 && Number.isInteger(xs[0] ?? 0),
  ensures: (xs) => sum(xs) === (xs[0] ?? 0),
});

export const belowAnything = forall(allBelow, {
  when: (xs) => xs.length === 0,
  ensures: (xs, limit) => allBelow(xs, limit),
});

// False: [0] has 0 at index 0.
export const neverAtItsIndex = forall(hasAt, { ensures: (xs) => !hasAt(xs) });
