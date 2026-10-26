/** The refund core with its off-by-one fixed: every property is provable. */

export interface RefundDecision {
  readonly ok: boolean;
  readonly refunded: number;
}

export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount > captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
