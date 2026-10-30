import { forall } from "@eutaxy/spec";
import { floorOf, locked, ratio, windowOf } from "./domain.ts";

export const windowStartsBefore = forall(windowOf, {
  when: (t) => Number.isInteger(t) && t >= 0 && t <= 1000000000000,
  ensures: (t) => windowOf(t) * 60000 <= t,
});
export const nextWindow = forall(windowOf, {
  when: (t) => Number.isInteger(t) && t >= 0 && t <= 1000000000000,
  ensures: (t) => windowOf(t + 60000) === windowOf(t) + 1,
});
export const lockedFromFive = forall(locked, {
  when: (a) => Number.isInteger(a),
  ensures: (a) => locked(a) === a >= 5,
});
export const floorKeepsIntegers = forall(floorOf, {
  when: (x) => Number.isInteger(x),
  ensures: (x) => floorOf(x) === x,
});
// True over the integers, which the Lean engine models; false for 0.5, which the SMT engine finds.
export const floorNeverLower = forall(floorOf, { ensures: (x) => floorOf(x) >= x });
export const halves = forall(ratio, {
  when: (a) => Number.isInteger(a),
  ensures: (a) => ratio(a, 2) + ratio(a, 2) === a,
});
// A division hidden under Number.isInteger is still a division: the Lean engine refuses it rather
// than read Number.isInteger as true, which would prove this false claim (1 / 2 is no integer).
export const halfIsInteger = forall(floorOf, {
  when: (x) => Number.isInteger(x),
  ensures: (x) => Number.isInteger(floorOf(x) / 2),
});
