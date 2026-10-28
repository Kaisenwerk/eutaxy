/**
 * The model of exhaustive exploration that Eutaxy proves: the schedules of
 * a uniform tree of choices, where every decision at depth i offers the
 * options `levels[i]`. A schedule picks one option (by index) at each
 * depth; they come depth first, the first option before the next, as the
 * enumerator in `engine` walks a tree (whose tests hold it to this model).
 * Written in the subset the Lean engine translates (structural recursion
 * over the levels), so what is proved is this code; the helpers below
 * state the claims, since a claim compares arrays by their elements, not
 * by reference.
 */

/** Every schedule of the levels, depth first: `[]` for no levels, none when a level offers nothing. */
export function schedules(levels: readonly (readonly string[])[]): readonly (readonly number[])[] {
  if (levels.length === 0) return [[]];
  const rest = schedules(levels.slice(1));
  return (levels[0] ?? []).flatMap((_, i) => rest.map((s) => [i, ...s]));
}

/** How many schedules the levels have: the product of how many options each offers. */
export function scheduleCount(levels: readonly (readonly string[])[]): number {
  return levels.reduce((n, options) => n * options.length, 1);
}

/** Whether a schedule picks an existing option at every depth of the levels, and has no more depths. */
export function withinLevels(
  schedule: readonly number[],
  levels: readonly (readonly string[])[],
): boolean {
  if (schedule.length === 0) return levels.length === 0;
  return (
    levels.length > 0 &&
    (schedule[0] ?? -1) >= 0 &&
    (schedule[0] ?? -1) < (levels[0] ?? []).length &&
    withinLevels(schedule.slice(1), levels.slice(1))
  );
}

/** Whether two schedules pick the same options, depth by depth. */
export function same(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0) return b.length === 0;
  return b.length > 0 && (a[0] ?? 0) === (b[0] ?? 0) && same(a.slice(1), b.slice(1));
}

/** Whether a list of schedules holds one the same as `s`. */
export function contains(all: readonly (readonly number[])[], s: readonly number[]): boolean {
  if (all.length === 0) return false;
  return same(all[0] ?? [], s) || contains(all.slice(1), s);
}

/** Whether no schedule in the list appears twice. */
export function noRepeats(all: readonly (readonly number[])[]): boolean {
  if (all.length === 0) return true;
  return !contains(all.slice(1), all[0] ?? []) && noRepeats(all.slice(1));
}

/** Whether `a` comes strictly before `b`, comparing depth by depth. */
export function before(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0) return b.length > 0;
  return (
    b.length > 0 &&
    ((a[0] ?? 0) < (b[0] ?? 0) || ((a[0] ?? 0) === (b[0] ?? 0) && before(a.slice(1), b.slice(1))))
  );
}

/** Whether every schedule in the list comes strictly before the next. */
export function ascending(all: readonly (readonly number[])[]): boolean {
  if (all.length === 0) return true;
  return (
    (all.slice(1).length === 0 || before(all[0] ?? [], all.slice(1)[0] ?? [])) &&
    ascending(all.slice(1))
  );
}
