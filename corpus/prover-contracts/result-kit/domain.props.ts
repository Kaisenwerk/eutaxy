import { forall } from "@eutaxy/spec";
import { attemptsLeft, judge, remaining } from "./domain.ts";

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
export const countsDown = forall(remaining, {
  when: (a) => Number.isInteger(a),
  ensures: (a, m) => {
    const r = remaining(a, m);
    if (r.ok) return r.value === 5 - a;
    return !m;
  },
});
export const lockedPassesThrough = forall(attemptsLeft, {
  ensures: (a, m) => {
    const r = attemptsLeft(a, m);
    if (r.ok) return m;
    return !m && (r.error.type === "locked") === a >= 5;
  },
});
