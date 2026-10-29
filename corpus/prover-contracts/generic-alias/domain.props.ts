import { forall } from "@eutaxy/spec";
import { judge } from "./domain.ts";

export const okIffMatches = forall(judge, { ensures: (a, m) => judge(a, m).ok === m });
// Planted false claim: a mismatch is refused, not accepted.
export const alwaysOk = forall(judge, { ensures: (a, m) => judge(a, m).ok });
