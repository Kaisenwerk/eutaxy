import { forall } from "@eutaxy/spec";
import { floorOf } from "./domain.ts";

export const fixesIntegers = forall(floorOf, {
  when: (x) => Number.isInteger(x),
  ensures: (x) => floorOf(x) === x,
});
