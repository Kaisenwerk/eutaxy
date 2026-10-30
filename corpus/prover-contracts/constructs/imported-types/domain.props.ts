import { forall } from "@eutaxy/spec";
import { withdraw } from "./domain.ts";

export const frozenDenied = forall(withdraw, {
  when: (a) => a.frozen,
  ensures: (a, x) => withdraw(a, x).kind === "deny",
});
export const overdrawDenied = forall(withdraw, {
  when: (a, x) => x > a.balance,
  ensures: (a, x) => withdraw(a, x).kind === "deny",
});
// Planted false claim: an account that is not frozen may still be overdrawn.
export const openAllows = forall(withdraw, {
  when: (a) => !a.frozen,
  ensures: (a, x) => withdraw(a, x).kind === "allow",
});
// `||` narrows its right operand where the left fails: there `d` is the other member.
export const remainingNonNegative = forall(withdraw, {
  when: (a, x) => Number.isInteger(a.balance) && Number.isInteger(x) && x >= 0,
  ensures: (a, x) => {
    const d = withdraw(a, x);
    return d.kind === "deny" || d.remaining >= 0;
  },
});
