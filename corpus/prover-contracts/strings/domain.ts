/** Strings in the subset: literals, equality, joining with +, string-literal union types, string fields. */

export interface Tagged {
  readonly kind: string;
  readonly code: number;
}

/**
 * @ensures{send-code-iff} forall (status: string) {
 *   decideAccess(status) === "send_code" ↔ status === "invited" ∨ status === "active"
 * }
 * @ensures{two-outcomes} forall (status: string) {
 *   decideAccess(status) === "send_code" ∨ decideAccess(status) === "waitlist"
 * }
 * @total
 */
export function decideAccess(status: "invited" | "active" | "disabled"): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}

/**
 * @ensures{never-empty} forall (address: string) { networkKey(address) !== "" }
 * @ensures{distinct-networks} forall (a b: string) { networkKey(a) === networkKey(b) ↔ a === b }
 */
export function networkKey(address: string): string {
  // biome-ignore lint/style/useTemplate: joining with + is in the subset; template literals are not
  return "evm:" + address;
}

/**
 * @ensures{kind-of-sign} forall (n: int) { (n < 0 → tag(n).kind === "neg") ∧ (n >= 0 → tag(n).kind === "pos") }
 * @ensures{code-kept} forall (n: int) { tag(n).code === n }
 * @ensures{escapes} forall (n: int) { label(n) !== "a\"b\\c\n" ∨ n === 0 }
 */
export function tag(n: number): Tagged {
  if (n < 0) return { kind: "neg", code: n };
  return { kind: "pos", code: n };
}

export function label(n: number): string {
  return n === 0 ? 'a"b\\c\n' : "other";
}
