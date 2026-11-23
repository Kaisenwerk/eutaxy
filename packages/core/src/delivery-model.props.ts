/**
 * The delivery model's claims, the first of v0.20's gate: an event is
 * delivered at most once more than either limit allows, never again after
 * a delivery that was handled, and exactly as often as the least of four
 * counts says (the run's end, the first handled delivery, and the room
 * each limit leaves). Each is about every list of outcomes and every pair
 * of limits that are whole and not negative: a limit of one half would
 * allow a redelivery and break the first. Their proofs, which need
 * induction, are supplied in delivery-model.props.lean and checked by
 * Lean's kernel. The sample keeps the TESTED rung's draws to small limits,
 * where a drawn list can reach them; it is not part of any claim.
 */

import { forall } from "@eutaxy/spec";
import { deliveries, least, unhandledFirst } from "./delivery-model.ts";

export const withinTheLimits = forall(deliveries, {
  sample: (_handled, limit, maxRedeliveries) => limit <= 4 && maxRedeliveries <= 4,
  when: (_handled, limit, maxRedeliveries) =>
    Number.isInteger(limit) &&
    Number.isInteger(maxRedeliveries) &&
    limit >= 0 &&
    maxRedeliveries >= 0,
  ensures: (handled, limit, maxRedeliveries) =>
    deliveries(handled, limit, maxRedeliveries) <= limit + 1 &&
    deliveries(handled, limit, maxRedeliveries) <= maxRedeliveries + 1,
});

export const noneAfterHandled = forall(deliveries, {
  sample: (_handled, limit, maxRedeliveries) => limit <= 4 && maxRedeliveries <= 4,
  when: (_handled, limit, maxRedeliveries) =>
    Number.isInteger(limit) &&
    Number.isInteger(maxRedeliveries) &&
    limit >= 0 &&
    maxRedeliveries >= 0,
  ensures: (handled, limit, maxRedeliveries) =>
    deliveries(handled, limit, maxRedeliveries) <= unhandledFirst(handled) + 1,
});

export const exactCount = forall(deliveries, {
  sample: (_handled, limit, maxRedeliveries) => limit <= 4 && maxRedeliveries <= 4,
  when: (_handled, limit, maxRedeliveries) =>
    Number.isInteger(limit) &&
    Number.isInteger(maxRedeliveries) &&
    limit >= 0 &&
    maxRedeliveries >= 0,
  ensures: (handled, limit, maxRedeliveries) =>
    deliveries(handled, limit, maxRedeliveries) ===
    least(
      handled.length,
      least(unhandledFirst(handled) + 1, least(limit + 1, maxRedeliveries + 1)),
    ),
});
