import { forall } from "@eutaxy/spec";
import { judge } from "./domain.ts";

export const okIffMatches = forall(judge, { ensures: (a, m) => judge(a, m).ok === m });
export const lockedFromFive = forall(judge, {
  ensures: (a, m) => {
    const r = judge(a, m);
    if (r.ok) return m;
    return (r.error.type === "locked") === a >= 5;
  },
});
// Planted false claim: a mismatch is refused, not accepted.
export const alwaysOk = forall(judge, { ensures: (a, m) => judge(a, m).ok });
