/**
 * Truthiness of a nullable record is a null test, since an object is
 * always truthy; of a nullable number it is not (0 and NaN are falsy too),
 * so that stays outside the subset.
 */

export interface Session {
  readonly ttl: number;
}

export function remaining(s: Session | null): number {
  if (!s) return 0;
  return s.ttl;
}

export const active = (s: Session | null): boolean => (s ? s.ttl > 0 : false);

export function orZero(n: number | null): number {
  return n ? n : 0;
}
