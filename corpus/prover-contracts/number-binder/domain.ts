/** A property over doubles is outside the engine's number model; the others on the same function are proved. */

/**
 * @ensures{over-doubles} forall (x: number) { abs(x) >= 0 }
 * @ensures{over-integers} forall (x: int) { abs(x) >= 0 }
 * @ensures{fixpoint} forall (x: int) { abs(abs(x)) === abs(x) }
 * @ensures{needs-strings} forall (x: int) (s: string) { abs(x) >= 0 }
 */
export function abs(x: number): number {
  return x < 0 ? -x : x;
}
