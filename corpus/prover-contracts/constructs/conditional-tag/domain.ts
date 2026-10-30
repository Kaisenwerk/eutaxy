/**
 * A tag chosen by a conditional inside the literal is read as a
 * conditional between two literals, the other fields as written in each.
 */

export type Level =
  | { readonly kind: "low"; readonly n: number }
  | { readonly kind: "high"; readonly n: number };

export function level(n: number, limit: number): Level {
  return { kind: n > limit ? "high" : "low", n };
}
