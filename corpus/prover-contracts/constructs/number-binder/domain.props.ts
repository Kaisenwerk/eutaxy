import { forall } from "@eutaxy/spec";
import { abs, shout } from "./domain.ts";

/** Over every number: proved under the engine's integer model, which every PROVEN names as an assumption. */
export const overDoubles = forall(abs, { ensures: (x) => abs(x) >= 0 });
export const overIntegers = forall(abs, {
  when: (x) => Number.isInteger(x),
  ensures: (x) => abs(x) >= 0,
});
export const fixpoint = forall(abs, { ensures: (x) => abs(abs(x)) === abs(x) });
export const plainString = forall(shout, {
  // biome-ignore lint/style/useTemplate: joining with + is in the subset; template literals are not
  ensures: (s) => shout(s) === s + "!",
});
export const needsARegex = forall(shout, {
  when: (s) => /^a+$/.test(s),
  // biome-ignore lint/style/useTemplate: joining with + is in the subset; template literals are not
  ensures: (s) => shout(s) === s + "!",
});
