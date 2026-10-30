import { forall } from "@eutaxy/spec";
import { level } from "./domain.ts";

export const highAboveLimit = forall(level, {
  ensures: (n, limit) => (level(n, limit).kind === "high") === n > limit,
});
export const keepsN = forall(level, {
  when: (n) => Number.isInteger(n),
  ensures: (n, limit) => level(n, limit).n === n,
});
// Planted false claim: the limit itself is low, not high.
export const highAtLimit = forall(level, {
  ensures: (n, limit) => (level(n, limit).kind === "high") === n >= limit,
});
