/** Nested conditionals, const bindings, if/else blocks and calls between the module's functions. */

export function clamp(x: number, lo: number, hi: number): number {
  const below = x < lo;
  if (below) {
    return lo;
  } else {
    // biome-ignore lint/complexity/useMathMinMax: the conditional operator is what this entry exercises; Math is outside the subset
    return x > hi ? hi : x;
  }
}

export function percent(x: number): number {
  return clamp(x, 0, 100);
}

export function sign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}
