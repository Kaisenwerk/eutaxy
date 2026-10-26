/** Boolean parameters and results, with the connectives on both sides. */

export interface Access {
  readonly allowed: boolean;
  readonly reason: number;
}

/**
 * @ensures{allowed-iff} forall (admin member banned: boolean) {
 *   decide(admin, member, banned).allowed ↔ (admin ∨ member) ∧ ¬ banned
 * }
 * @ensures{reason-when-banned} forall (admin member banned: boolean) {
 *   banned ==> decide(admin, member, banned).reason === 2
 * }
 * @ensures{reason-codes} forall (admin member banned: boolean) {
 *   decide(admin, member, banned).reason >= 0 ∧ decide(admin, member, banned).reason <= 2
 * }
 */
export function decide(admin: boolean, member: boolean, banned: boolean): Access {
  if (banned) return { allowed: false, reason: 2 };
  if (admin || member) return { allowed: true, reason: 0 };
  return { allowed: false, reason: 1 };
}

/**
 * @ensures{xor} forall (a b: boolean) { either(a, b) ↔ (a ∧ ¬ b) ∨ (¬ a ∧ b) }
 * @ensures{same-value} forall (a b: boolean) { either(a, b) ≡ (a !== b) }
 */
export function either(a: boolean, b: boolean): boolean {
  return (a && !b) || (!a && b);
}
