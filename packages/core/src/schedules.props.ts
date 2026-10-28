/**
 * The enumeration model's claims, which v0.8's gate needs PROVEN: the
 * number of schedules is the product of the choices, none repeats, every
 * one picks an existing option at every depth, and they come in depth-first
 * (lexicographic) order. Bounded here only so that sampling stays fast.
 */

import { forall } from "@eutaxy/spec";
import { scheduleCount, schedules } from "./schedules.ts";

export const countIsProduct = forall(schedules, {
  when: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => schedules(levels).length === scheduleCount(levels),
});

export const inBounds = forall(schedules, {
  when: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) =>
    schedules(levels).every(
      (s) =>
        s.length === levels.length &&
        s.every((i, d) => Number.isInteger(i) && i >= 0 && i < (levels[d] ?? []).length),
    ),
});

/** Each schedule comes strictly after the one before it, comparing depth by depth; so none repeats. */
export const depthFirstOrder = forall(schedules, {
  when: (levels) => levels.length <= 4 && levels.every((l) => l.length <= 4),
  ensures: (levels) => {
    const all = schedules(levels);
    return all.every((s, k) => {
      if (k === 0) return true;
      const prev = all[k - 1] as readonly number[];
      const d = s.findIndex((i, j) => i !== prev[j]);
      return d >= 0 && (s[d] as number) > (prev[d] as number);
    });
  },
});
