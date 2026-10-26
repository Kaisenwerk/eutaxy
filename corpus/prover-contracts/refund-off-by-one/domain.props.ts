import { forall } from "@eutaxy/spec";
import { decideRefund } from "./domain.ts";

export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
export const addsTheAmount = forall(decideRefund, {
  when: (captured, refunded, amount) => decideRefund(captured, refunded, amount).ok,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded === refunded + amount,
});
export const fullRefundAllowed = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    0 <= refunded && amount > 0 && refunded + amount === captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).ok,
});
