import { forall } from "@eutaxy/spec";
import { boxed, unboxed } from "./domain.ts";

export const neverNegative = forall(boxed, {
  when: (n) => Number.isInteger(n),
  ensures: (n) => boxed(n).value >= 0,
});
export const keepsNonNegatives = forall(unboxed, {
  when: (n) => n >= 0,
  ensures: (n) => unboxed(n) === n,
});
// Planted false claim: a negative input is raised to 0, not kept.
export const keepsEverything = forall(unboxed, { ensures: (n) => unboxed(n) === n });
