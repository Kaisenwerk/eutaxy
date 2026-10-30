/**
 * Generic and imported functions are read at each call, at the types the
 * call gives them: `box` at `number`, `atLeast` as it is.
 */

import { atLeast, type Box, box } from "./helpers.ts";

export const boxed = (n: number): Box<number> => box(atLeast(n, 0));

export function unboxed(n: number): number {
  return boxed(n).value;
}
