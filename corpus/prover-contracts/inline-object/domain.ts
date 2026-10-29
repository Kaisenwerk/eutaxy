/** Inline object types on a parameter and as a return type: records named as the compiler prints them. */

export function clamp(range: { readonly lo: number; readonly hi: number }, x: number): number {
  if (x < range.lo) return range.lo;
  if (x > range.hi) return range.hi;
  return x;
}

export function bounds(lo: number, hi: number): { readonly lo: number; readonly hi: number } {
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}
