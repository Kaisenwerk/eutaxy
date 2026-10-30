/**
 * Lists in the subset: readonly T[] as Lean's List, literals with a
 * trailing spread, length, xs[0] ?? d, slice(1), map and flatMap (with the
 * index), every, some, reduce, and structural recursion on a list's
 * slice(1). The Lean engine translates them (its translation checked on
 * drawn lists); the SMT engine does not take lists. Claims that need
 * induction are beyond the push-button tactic script.
 */

export function schedules(levels: readonly (readonly string[])[]): readonly (readonly number[])[] {
  if (levels.length === 0) return [[]];
  const rest = schedules(levels.slice(1));
  return (levels[0] ?? []).flatMap((_, i) => rest.map((s) => [i, ...s]));
}

export function scheduleCount(levels: readonly (readonly string[])[]): number {
  return levels.reduce((n, options) => n * options.length, 1);
}

export function sum(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return (xs[0] ?? 0) + sum(xs.slice(1));
}

export function doubled(xs: readonly number[]): readonly number[] {
  return xs.map((x) => x + x);
}

export function allBelow(xs: readonly number[], limit: number): boolean {
  return xs.every((x) => x < limit);
}

export function hasAt(xs: readonly number[]): boolean {
  return xs.some((x, i) => x === i);
}

export function pushFront(x: number, xs: readonly number[]): readonly number[] {
  return [x, ...xs];
}
