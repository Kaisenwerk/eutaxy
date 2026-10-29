/** Two aliases of one shape: a record literal is told apart by the type its context declares. */

export type Credit = { readonly amount: number };
export type Debit = { readonly amount: number };

export function credit(amount: number): Credit {
  return { amount };
}

export function debit(amount: number): Debit {
  return { amount: -amount };
}

export function net(c: Credit, d: Debit): number {
  const total: Debit = { amount: c.amount + d.amount };
  return total.amount;
}
