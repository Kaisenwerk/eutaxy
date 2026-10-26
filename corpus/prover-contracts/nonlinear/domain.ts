/** Multiplication of two variables is beyond the linear arithmetic the tactic stack decides: a true claim the engine gives up on. */

/**
 * @ensures{square-non-negative} forall (x: int) { square(x) >= 0 }
 * @ensures{by-constant} forall (x: int) { x >= 0 ==> triple(x) >= x }
 */
export function square(x: number): number {
  return x * x;
}

export function triple(x: number): number {
  return 3 * x;
}
