/**
 * One function reassigns Math.floor. Nothing here calls it, but once it
 * has run, floorOf computes something else, so the reader refuses every
 * function of a file that assigns to a built-in: no claim here is proved,
 * and the TESTED rung, which runs the real code, still holds.
 */

export function floorOf(x: number): number {
  return Math.floor(x);
}

export function patchFloor(): void {
  Math.floor = (x: number): number => x;
}
