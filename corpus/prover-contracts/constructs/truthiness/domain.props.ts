import { forall } from "@eutaxy/spec";
import { active, orZero, remaining } from "./domain.ts";

export const missingIsZero = forall(remaining, {
  ensures: (s) => s !== null || remaining(s) === 0,
});
export const activeHasTime = forall(active, {
  ensures: (s) => !active(s) || (s !== null && s.ttl > 0),
});
// Planted false claim: a session's own ttl may be zero or negative.
export const presentIsPositive = forall(remaining, {
  ensures: (s) => s === null || remaining(s) > 0,
});
// Outside the subset, and false on NaN, which is falsy: TESTED finds it.
export const orZeroKeeps = forall(orZero, { ensures: (n) => n === null || orZero(n) === n });
