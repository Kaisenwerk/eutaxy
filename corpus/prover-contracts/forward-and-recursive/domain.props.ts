import { forall } from "@eutaxy/spec";
import { fact, shifted, usesFact, viaZero, zero_ } from "./domain.ts";

export const positive = forall(shifted, { when: (x) => x >= 0, ensures: (x) => shifted(x) > 0 });
export const notShadowed = forall(zero_, { ensures: (x) => zero_(x) === 0 });
/** The binder is spelled like the emitted name of `zero_` would be under a suffixing scheme; it must not shadow it. */
export const callsZero = forall(viaZero, { ensures: (f_zero_) => viaZero(f_zero_) === 0 });
export const nonNegative = forall(fact, {
  when: (n) => Number.isInteger(n) && 0 <= n,
  ensures: (n) => fact(n) >= 1,
});
export const viaFact = forall(usesFact, {
  when: (n) => Number.isInteger(n) && 0 <= n,
  ensures: (n) => usesFact(n) >= 1,
});
