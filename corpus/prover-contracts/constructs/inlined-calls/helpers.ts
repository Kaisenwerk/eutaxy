/** Helpers in a file of their own: a generic alias, a generic helper, and a plain one. */

export type Box<T> = { readonly value: T };

export const box = <T>(value: T): Box<T> => ({ value });

export function atLeast(x: number, floor: number): number {
  // biome-ignore lint/complexity/useMathMinMax: Math is outside the subset; the conditional operator is in it
  return x < floor ? floor : x;
}
