import { forall, total } from "@eutaxy/spec";
import { clamp, percent, sign } from "./domain.ts";

export const within = forall(clamp, {
  when: (_x, lo, hi) => lo <= hi,
  ensures: (x, lo, hi) => lo <= clamp(x, lo, hi) && clamp(x, lo, hi) <= hi,
});
export const identity = forall(clamp, {
  when: (x, lo, hi) => lo <= x && x <= hi,
  ensures: (x, lo, hi) => clamp(x, lo, hi) === x,
});
export const clampTotal = total(clamp);
export const bounded = forall(percent, {
  ensures: (x) => 0 <= percent(x) && percent(x) <= 100,
});
export const idempotent = forall(percent, {
  ensures: (x) => percent(percent(x)) === percent(x),
});
export const signCases = forall(sign, {
  ensures: (x) =>
    (x <= 0 || sign(x) === 1) && (x >= 0 || sign(x) === -1) && (x !== 0 || sign(x) === 0),
});
