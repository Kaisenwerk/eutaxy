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

export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
