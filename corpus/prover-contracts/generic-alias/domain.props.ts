import { forall } from "@eutaxy/spec";
import { judge, valueOr } from "./domain.ts";

export const okIffMatches = forall(judge, { ensures: (a, m) => judge(a, m).ok === m });
// Planted false claim: a mismatch is refused, not accepted.
export const alwaysOk = forall(judge, { ensures: (a, m) => judge(a, m).ok });
// The claim narrows by the tag as the function does.
export const valueWhenOk = forall(valueOr, {
  when: (r, f) =>
    Number.isInteger(f) && (r.ok ? Number.isInteger(r.value) : Number.isInteger(r.error.until)),
  ensures: (r, f) => (r.ok ? valueOr(r, f) === r.value : valueOr(r, f) === r.error.until + f),
});
