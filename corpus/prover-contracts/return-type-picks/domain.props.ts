import { forall } from "@eutaxy/spec";
import { credit, debit, net } from "./domain.ts";

export const netIsSum = forall(net, {
  when: (c, d) => Number.isInteger(c.amount) && Number.isInteger(d.amount),
  ensures: (c, d) => net(c, d) === c.amount + d.amount,
});
export const creditKeeps = forall(credit, {
  when: (a) => Number.isInteger(a),
  ensures: (a) => credit(a).amount === a,
});
// Planted false claim: a debit negates its amount.
export const debitKeeps = forall(debit, { ensures: (a) => debit(a).amount === a });
