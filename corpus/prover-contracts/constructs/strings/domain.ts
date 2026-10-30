/** Strings in the subset: literals, equality, joining with +, string-literal union types, string fields. */

export interface Tagged {
  readonly kind: string;
  readonly code: number;
}

export function decideAccess(status: "invited" | "active" | "disabled"): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}

export function networkKey(address: string): string {
  // biome-ignore lint/style/useTemplate: joining with + is in the subset; template literals are not
  return "evm:" + address;
}

export function sameNetwork(a: string, b: string): boolean {
  return networkKey(a) === networkKey(b);
}

export function tag(n: number): Tagged {
  if (n < 0) return { kind: "neg", code: n };
  return { kind: "pos", code: n };
}

export function label(n: number): string {
  return n === 0 ? 'a"b\\c\n' : "other";
}
