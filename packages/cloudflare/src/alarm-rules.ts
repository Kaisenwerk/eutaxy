/**
 * The rules a Durable Object's alarm is retried and superseded by, as
 * Cloudflare documents them (developers.cloudflare.com/durable-objects/
 * api/base/#alarm): a handler that throws is retried with exponential
 * backoff starting at two seconds, up to six times, and an object has
 * one alarm, which a later `setAlarm` or `deleteAlarm` replaces. Written
 * in the subset the Lean engine translates, so what is proved is this
 * code, and `alarmRetries`, `retryDelayMs`, `nextGeneration` and
 * `superseded` are also the code that runs: alarms.ts retries, waits and
 * drops by them and holds no such decision of its own. Whether a failed
 * alarm is retried is `redelivery`'s decision, core's proved rule, under
 * `alarmRetries`, counting an event's attempts, which are one more than
 * its retries; the claims hold that constant to six through the delays.
 * `retriedAfter` and `generationAfter` state the claims in
 * alarm-rules.props.ts.
 */

/** The retries Cloudflare makes of an alarm whose handler failed. */
export const alarmRetries = 6;

/** The delay before the first retry. */
const firstRetryMs = 2_000;

/**
 * How long after a run that failed its retry starts, `retryCount` being
 * the retries made before that run: two seconds, doubled for each.
 */
export function retryDelayMs(retryCount: number): number {
  return firstRetryMs * doublings(retryCount);
}

/**
 * Two to the power of `count`, written out for the counts a retry
 * follows, since `**` is outside the subset: no retry follows the sixth,
 * so nothing reads past the last line.
 */
function doublings(count: number): number {
  if (count <= 0) return 1;
  if (count === 1) return 2;
  if (count === 2) return 4;
  if (count === 3) return 8;
  if (count === 4) return 16;
  return 32;
}

/** The generation a `setAlarm` or `deleteAlarm` starts: one no alarm of the object had before. */
export function nextGeneration(generation: number): number {
  return generation + 1;
}

/** Whether an alarm event or a retry of it is superseded: the object's alarm is of another generation, set again or deleted since. */
export function superseded(generation: number, current: number): boolean {
  return generation !== current;
}

/** Whether Cloudflare's limit leaves a retry to an alarm that has had `retryCount` of them. */
export function retriedAfter(retryCount: number): boolean {
  return retryCount < alarmRetries;
}

/** The object's generation after `changes` to its alarm, each a `setAlarm` (true) or a `deleteAlarm` (false), from `generation`. */
export function generationAfter(generation: number, changes: readonly boolean[]): number {
  if (changes.length === 0) return generation;
  return generationAfter(nextGeneration(generation), changes.slice(1));
}
