import { forall } from "@eutaxy/spec";
import { square, triple } from "./domain.ts";

export const squareNonNegative = forall(square, { ensures: (x) => square(x) >= 0 });
export const byConstant = forall(triple, { when: (x) => x >= 0, ensures: (x) => triple(x) >= x });
