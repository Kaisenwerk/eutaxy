/**
 * The rule a queue message's delivery is decided by, as Cloudflare
 * documents it. Of a handler's calls to `ack()` and `retry()` on one
 * message the first wins and every later one is ignored
 * (developers.cloudflare.com/queues/configuration/batching-retries/,
 * "Explicit acknowledgement and retries"); a message whose handler
 * completed without deciding is acknowledged by the platform, and one
 * acknowledged is not delivered again, whatever the handler does after
 * (developers.cloudflare.com/queues/configuration/javascript-apis/,
 * "Consumer"). Written in the subset the Lean engine translates, so what
 * is proved is this code, and the four rule functions are also the code
 * that runs: `deliverMessage` in queues.ts decides by them and holds no
 * decision of its own. The three below them state the claims in
 * queue-decision.props.ts, two of them as a model of a whole delivery;
 * queue-decision.test.ts holds `deliverMessage` to that model.
 */

/** What a handler decides of a message. */
export type Decision = "ack" | "retry";

/** What a delivery holds of its message: the decision that stands, or none yet. */
export type Standing = Decision | "none";

/** The decision that stands after a call: the first made, which no later call replaces. */
export function standsAfter(standing: Standing, call: Decision): Standing {
  return standing === "none" ? call : standing;
}

/** Whether a call takes effect: only one made while no decision stands. */
export function takesEffect(standing: Standing): boolean {
  return standing === "none";
}

/** Whether the platform acknowledges the message itself: its handler completed without deciding. */
export function acknowledgedImplicitly(completed: boolean, standing: Standing): boolean {
  return completed && standing === "none";
}

/** Whether the delivery was handled, so that the message is not delivered again: its decision is an acknowledgement. */
export function handled(standing: Standing): boolean {
  return standing === "ack";
}

/** The decision that stands after a handler's calls on one message, in order, from the one standing before them. */
export function standingAfter(standing: Standing, calls: readonly Decision[]): Standing {
  if (calls.length === 0) return standing;
  return standingAfter(standsAfter(standing, calls[0] ?? "ack"), calls.slice(1));
}

/**
 * The decision a delivery ends with: the handler's calls on the message
 * in order, then the platform's own acknowledgement where the rule gives
 * one. `completed` says whether the handler completed and that
 * acknowledgement was made; a handler that threw, or a crash that ended
 * it or lost the acknowledgement, is one that did not.
 */
export function settled(calls: readonly Decision[], completed: boolean): Standing {
  const standing = standingAfter("none", calls);
  return acknowledgedImplicitly(completed, standing) ? standsAfter(standing, "ack") : standing;
}

/** Whether every call is one a handler can make, as the types say; the claims repeat it for the Lean engine, which reads a union of string literals as any string. */
export function decisions(calls: readonly Decision[]): boolean {
  return calls.every((call) => call === "ack" || call === "retry");
}
