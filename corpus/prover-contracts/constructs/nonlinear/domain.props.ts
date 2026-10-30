import { forall } from "@eutaxy/spec";
import { square, triple } from "./domain.ts";

export const squareNonNegative = forall(square, { ensures: (x) => square(x) >= 0 });
export const byConstant = forall(triple, { when: (x) => x >= 0, ensures: (x) => triple(x) >= x });

// A sample limits what TESTED draws, not the claim: the engines prove or refute it for every input.
export const byConstantSampled = forall(triple, {
  sample: (x) => x <= 100,
  when: (x) => x >= 0,
  ensures: (x) => triple(x) >= x,
});
export const smallInsideTheSample = forall(triple, {
  sample: (x) => Number.isInteger(x) && 0 <= x && x <= 10,
  ensures: (x) => triple(x) <= 30,
});
