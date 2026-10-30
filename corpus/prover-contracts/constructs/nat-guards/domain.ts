/** Properties that hold only under their preconditions, which the engine turns into hypotheses. */

export function withdraw(balance: number, amount: number): number {
  if (amount < 0) return balance;
  if (amount > balance) return balance;
  return balance - amount;
}

export function twice(n: number): number {
  return n + n;
}
