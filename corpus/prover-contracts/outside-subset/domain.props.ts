import { forall } from "@eutaxy/spec";
import { same, sumTo } from "./domain.ts";

// Bounded, since the loop never ends on an infinite input and sampling draws one.
export const nonNegative = forall(sumTo, {
  when: (n) => Number.isInteger(n) && 0 <= n && n < 10_000,
  ensures: (n) => sumTo(n) >= 0,
});
export const identity = forall(same, { ensures: (x) => same(x) === x });
