/** Nested conditionals, const bindings, if/else blocks and calls between the module's functions. */

/**
 * @ensures{within} forall (x lo hi: int) { lo <= hi ==> lo <= clamp(x, lo, hi) ∧ clamp(x, lo, hi) <= hi }
 * @ensures{identity} forall (x lo hi: int) { lo <= x ∧ x <= hi ==> clamp(x, lo, hi) === x }
 * @total
 */
export function clamp(x: number, lo: number, hi: number): number {
  const below = x < lo;
  if (below) {
    return lo;
  } else {
    // biome-ignore lint/complexity/useMathMinMax: the conditional operator is what this entry exercises; Math is outside the subset
    return x > hi ? hi : x;
  }
}

/**
 * @ensures{bounded} forall (x: int) { 0 <= percent(x) ∧ percent(x) <= 100 }
 * @ensures{idempotent} forall (x: int) { percent(percent(x)) === percent(x) }
 */
export function percent(x: number): number {
  return clamp(x, 0, 100);
}

/**
 * @ensures{sign-cases} forall (x: int) {
 *   (x > 0 → sign(x) === 1) ∧ (x < 0 → sign(x) === -1) ∧ (x === 0 → sign(x) === 0)
 * }
 */
export function sign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}
