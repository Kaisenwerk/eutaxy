/**
 * The refund core as the planted bug has it: a refund that brings the total
 * exactly to the captured amount is rejected. The engine proves the two
 * sound properties and gives up on the false one; Lean does not say why a
 * proof fails, so a false claim and a weak tactic look alike here, and the
 * TESTED rung is what refutes it.
 */

export interface RefundDecision {
  readonly ok: boolean;
  readonly refunded: number;
}

/**
 * @ensures{within-captured} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ refunded <= captured ==>
 *   decideRefund(captured, refunded, amount).refunded <= captured
 * }
 * @ensures{adds-the-amount} forall (captured refunded amount: int) {
 *   decideRefund(captured, refunded, amount).ok ==>
 *   decideRefund(captured, refunded, amount).refunded === refunded + amount
 * }
 * @ensures{full-refund-allowed} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ amount > 0 ∧ refunded + amount === captured ==>
 *   decideRefund(captured, refunded, amount).ok
 * }
 */
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
