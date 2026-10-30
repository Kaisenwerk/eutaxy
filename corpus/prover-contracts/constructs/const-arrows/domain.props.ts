import { forall } from "@eutaxy/spec";
import { clampAttempts, nextWindow, remaining } from "./domain.ts";

export const withinBounds = forall(clampAttempts, {
  when: (a, m) => Number.isInteger(a) && Number.isInteger(m) && 0 <= m,
  ensures: (a, m) => 0 <= clampAttempts(a, m) && clampAttempts(a, m) <= m,
});
export const advances = forall(nextWindow, {
  when: (i) => Number.isInteger(i),
  ensures: (i, l) => nextWindow(i, l).index === i + 1,
});
export const neverNegative = forall(remaining, {
  when: (a, m) => Number.isInteger(a) && Number.isInteger(m) && 0 <= m,
  ensures: (a, m) => remaining(a, m) >= 0,
});
// Planted false claim: a negative count clamps to zero, not to itself.
export const keepsAttempts = forall(clampAttempts, {
  when: (a, m) => Number.isInteger(a) && Number.isInteger(m) && a <= m,
  ensures: (a, m) => clampAttempts(a, m) === a,
});
