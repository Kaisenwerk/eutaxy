/**
 * The pure core of refunds: whether a refund may go ahead, and the refunded
 * total after it. No I/O; the shell reads the order and writes the result.
 *
 * Planted bug: a refund that brings the total exactly to the captured
 * amount is rejected (`>=` where `>` was meant). Nothing breaks, so no
 * system invariant notices; the `fullRefundAllowed` property in
 * `domain.props.ts` does, on an
 * input the simulator passes once one refund has landed before the other.
 */

export interface RefundDecision {
  readonly ok: boolean;
  /** The refunded total after this decision. */
  readonly refunded: number;
}

export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
