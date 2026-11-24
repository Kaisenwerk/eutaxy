/**
 * The claims of the alarm's retry rule, part of v0.20's gate: the first
 * retry waits two seconds; each later one waits twice as long as the one
 * before, through every retry Cloudflare's limit leaves; the last retry
 * the limit leaves waits sixty-four seconds; and an alarm event is
 * superseded exactly when the object's alarm was set again or deleted
 * after it, however often. The second and third hold the limit to six:
 * a seventh retry would have no delay twice the sixth's, and with five
 * the last would wait thirty-two seconds. The last claim is about every
 * list of changes and every generation a run can reach: whole, not
 * negative and at most a thousand million, far below where a double
 * stops counting by one. Its proof, which needs induction, is supplied
 * in alarm-rules.props.lean and checked by Lean's kernel.
 */

import { forall } from "@eutaxy/spec";
import { generationAfter, retriedAfter, retryDelayMs, superseded } from "./alarm-rules.ts";

export const backoffStartsAtTwoSeconds = forall(retryDelayMs, {
  when: (retryCount) => retryCount === 0,
  ensures: (retryCount) => retryDelayMs(retryCount) === 2_000,
});

export const backoffDoubles = forall(retryDelayMs, {
  when: (retryCount) =>
    Number.isInteger(retryCount) && retryCount >= 0 && retriedAfter(retryCount + 1),
  ensures: (retryCount) => retryDelayMs(retryCount + 1) === 2 * retryDelayMs(retryCount),
});

export const lastRetryWaitsSixtyFourSeconds = forall(retryDelayMs, {
  when: (retryCount) =>
    Number.isInteger(retryCount) &&
    retryCount >= 0 &&
    retriedAfter(retryCount) &&
    !retriedAfter(retryCount + 1),
  ensures: (retryCount) => retryDelayMs(retryCount) === 64_000,
});

export const supersededByAnyChange = forall(generationAfter, {
  when: (generation) =>
    Number.isInteger(generation) && generation >= 0 && generation <= 1_000_000_000,
  ensures: (generation, changes) =>
    superseded(generation, generationAfter(generation, changes)) === changes.length > 0,
});
