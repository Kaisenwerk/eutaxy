/** A function over types imported from another file: the compiler resolves them from where the module is. */

import type { Account, Decision } from "./types.ts";

export function withdraw(a: Account, amount: number): Decision {
  if (a.frozen || amount > a.balance) return { kind: "deny" };
  return { kind: "allow", remaining: a.balance - amount };
}
