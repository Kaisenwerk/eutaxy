/**
 * The model of exhaustive exploration that Eutaxy proves: the schedules of
 * a uniform tree of choices, where every decision at depth i offers the
 * options `levels[i]`. A schedule picks one option (by index) at each
 * depth; they come depth first, the first option before the next, as the
 * enumerator in `engine` walks a tree (whose tests hold it to this model).
 * Written as structural recursion over the levels, so that it is the same
 * definition an engine translates.
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
