import { forall } from "@eutaxy/spec";
import { next } from "./domain.ts";

export const countGrows = forall(next, {
  when: (s) => Number.isInteger(s.count) && s.count < 1000000,
  ensures: (s) => next(s).count === s.count + 1,
});
export const phaseFlips = forall(next, {
  ensures: (s) => (next(s).phase === "busy") === (s.phase === "idle"),
});
// Planted false claim: the count is not kept.
export const countKept = forall(next, { ensures: (s) => next(s).count === s.count });
