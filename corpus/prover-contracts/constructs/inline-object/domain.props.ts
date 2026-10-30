import { forall } from "@eutaxy/spec";
import { bounds, clamp } from "./domain.ts";

export const within = forall(clamp, {
  when: (r, x) =>
    Number.isInteger(r.lo) && Number.isInteger(r.hi) && Number.isInteger(x) && r.lo <= r.hi,
  ensures: (r, x) => r.lo <= clamp(r, x) && clamp(r, x) <= r.hi,
});
export const ordered = forall(bounds, {
  when: (lo, hi) => Number.isInteger(lo) && Number.isInteger(hi),
  ensures: (lo, hi) => bounds(lo, hi).lo <= bounds(lo, hi).hi,
});
// Planted false claim: clamping does not always give the lower bound.
export const atLo = forall(clamp, { ensures: (r, x) => clamp(r, x) === r.lo });
