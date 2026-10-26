/** A caller declared before its callee is proved (Lean sees the callee first); a recursive function is outside the subset, and so is what calls it. */

export function shifted(x: number): number {
  return later(x) + 1;
}

function later(x: number): number {
  // biome-ignore lint/complexity/useMathMinMax: the conditional operator is in the subset; Math is not
  return x < 0 ? 0 : x;
}

export function zero_(x: number): number {
  return x - x;
}

/** The parameter is spelled like the emitted name of `zero_` would be under a suffixing scheme; it must not shadow it. */
export function viaZero(f_zero_: number): number {
  return zero_(f_zero_);
}

export function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
}

export function usesFact(n: number): number {
  return fact(n);
}
