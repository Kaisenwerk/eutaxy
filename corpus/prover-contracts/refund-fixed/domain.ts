/** The refund core with its off-by-one fixed: every property is provable. */

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
 * @total
 */
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount > captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
