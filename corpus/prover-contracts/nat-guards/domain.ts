/**
 * Properties that hold only under their binders' domains and guards, which the engine turns into
 * hypotheses. The bigint property is unsupported: a BigInt argument to a function over number throws.
 */

/**
 * @ensures{never-negative} forall (balance: nat) (amount: int ∈ [0, 1_000]) { withdraw(balance, amount) >= 0 }
 * @ensures{at-most-balance} forall (balance: nat) (amount: int) { withdraw(balance, amount) <= balance }
 * @ensures{exact-when-affordable} forall (balance amount: nat) { amount <= balance ==> withdraw(balance, amount) === balance - amount }
 */
export function withdraw(balance: number, amount: number): number {
  if (amount < 0) return balance;
  if (amount > balance) return balance;
  return balance - amount;
}

/**
 * @ensures{small-double} forall (n: int ∈ (0, 50)) { twice(n) < 100 }
 * @ensures{bigint-too} forall (n: bigint ∈ [0n, 10n]) { twice(n) <= 20 }
 */
export function twice(n: number): number {
  return n + n;
}
