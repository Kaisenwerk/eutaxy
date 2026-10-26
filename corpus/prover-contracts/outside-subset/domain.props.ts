import { forall } from "@eutaxy/spec";
import { same, sumTo } from "./domain.ts";

export const nonNegative = forall(sumTo, { ensures: (n) => sumTo(n) >= 0 });
export const identity = forall(same, { ensures: (x) => same(x) === x });
