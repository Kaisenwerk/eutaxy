import { forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";

// Amounts are cents, so every claim is about integers and says so: `number` is the double type, and
// decideRefund on NaN approves with a NaN total. The guard is spelled out in each precondition because
// the engines read a claim in the module's scope, where a helper of this file would not exist.
export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(captured) &&
    Number.isInteger(refunded) &&
    Number.isInteger(amount) &&
    0 <= refunded &&
    refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
export const addsTheAmount = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(captured) &&
    Number.isInteger(refunded) &&
    Number.isInteger(amount) &&
    decideRefund(captured, refunded, amount).ok,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded === refunded + amount,
});
export const fullRefundAllowed = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(captured) &&
    Number.isInteger(refunded) &&
    Number.isInteger(amount) &&
    0 <= refunded &&
    amount > 0 &&
    refunded + amount === captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).ok,
});
