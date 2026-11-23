/**
 * The model of delivery that Eutaxy proves: how often an event is
 * delivered under the redelivery rule every platform shares. An attempt
 * that was not handled is delivered again while the platform's own limit
 * on redeliveries and the scenario's bound both leave room. Written in the
 * subset the Lean engine translates, so what is proved is this code. The
 * rule, `redelivers`, is also the code that runs: `redelivery` in
 * delivery.ts decides by it. The count, `deliveries`, models the loops
 * that deliver, which are the platforms' own code; delivery.test.ts
 * holds a loop over `redelivery` to it on every case up to a bound. The
 * helpers below state the claims.
 */

/** Whether an attempt that was not handled is delivered again: not once the redeliveries so far, `attempt - 1`, have reached either limit. */
export function redelivers(attempt: number, limit: number, maxRedeliveries: number): boolean {
  return !(attempt - 1 >= limit || attempt - 1 >= maxRedeliveries);
}

/**
 * How many times an event is delivered when `handled` says of each
 * delivery in turn whether it was handled; the list's end is the end of
 * the run.
 */
export function deliveries(
  handled: readonly boolean[],
  limit: number,
  maxRedeliveries: number,
): number {
  return deliveriesFrom(handled, 1, limit, maxRedeliveries);
}

/** The same from a later attempt on, one the limits still cover: the deliveries from `attempt` to the last. */
export function deliveriesFrom(
  handled: readonly boolean[],
  attempt: number,
  limit: number,
  maxRedeliveries: number,
): number {
  if (handled.length === 0) return 0;
  if ((handled[0] ?? true) || !redelivers(attempt, limit, maxRedeliveries)) return 1;
  return 1 + deliveriesFrom(handled.slice(1), attempt + 1, limit, maxRedeliveries);
}

/** How many deliveries at the list's start were not handled. */
export function unhandledFirst(handled: readonly boolean[]): number {
  if (handled.length === 0) return 0;
  if (handled[0] ?? true) return 0;
  return 1 + unhandledFirst(handled.slice(1));
}

/** The smaller of two numbers. */
export function least(a: number, b: number): number {
  // biome-ignore lint/complexity/useMathMinMax: Math.min is outside the subset the Lean engine translates
  return a < b ? a : b;
}
