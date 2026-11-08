/**
 * The delivery conventions every platform shares, and the differential
 * runner's raw sides with them: how an attempt names its invocation, which
 * pending event is delivered next, and the redelivery rule, which applies
 * the same reading of a platform's limit without any of its proxy code.
 */

import type { EventRef } from "./platform.ts";
import type { Bounds } from "./scenario.ts";

/** The invocation one attempt of an event runs as: `<event>#<attempt>`, so a schedule's faults stay keyed when other events are removed. */
export function invocationOf(event: EventRef): string {
  return `${event.id}#${event.attempt}`;
}

/**
 * The pending event to deliver next, as the engine and the raw sides pick
 * it: the earliest by `at` (an event without one is due now), and the first
 * queued among equals. The index into `pending`. Pure.
 */
export function earliestEvent(pending: readonly EventRef[]): number {
  let best = 0;
  for (let i = 1; i < pending.length; i++)
    if ((pending[i]?.at ?? 0) < (pending[best]?.at ?? 0)) best = i;
  return best;
}

/**
 * The next attempt of an event that was not handled (a message not
 * acknowledged or deleted, a request its caller resends, an alarm that
 * failed), or null when it is dropped (dead-lettered, given up on). It is
 * delivered again while both the platform's own limit on redeliveries
 * (Queues' `max_retries`, the caller's `retries`, SQS's `maxReceiveCount`
 * less the first delivery, an alarm's six retries) and the scenario's
 * `maxRedeliveries` leave room; the redeliveries so far are `attempt - 1`.
 * Pure.
 */
export function redelivery(
  event: EventRef,
  limit: number,
  bounds: Pick<Bounds, "maxRedeliveries">,
): EventRef | null {
  const redeliveries = event.attempt - 1;
  if (redeliveries >= limit || redeliveries >= bounds.maxRedeliveries) return null;
  return { ...event, attempt: event.attempt + 1 };
}
