/**
 * The claims of the queue's decision rule, part of v0.20's gate: the
 * first decision wins, whatever the handler calls after it and however
 * it ends; a message the handler did not decide is acknowledged exactly
 * when the handler completed; a delivery is handled exactly when its
 * first call is an acknowledgement, or it made none and completed; and
 * a call takes effect exactly when none came before it. Each is about
 * every list of calls. A call is an acknowledgement or a retry, which
 * the types say and `decisions` repeats: the Lean engine reads a union
 * of string literals as any string. The proofs that need induction are
 * supplied in queue-decision.props.lean and checked by Lean's kernel.
 */

import { forall } from "@eutaxy/spec";
import { decisions, handled, settled, standingAfter, takesEffect } from "./queue-decision.ts";

export const firstDecisionWins = forall(settled, {
  when: (calls) => calls.length > 0 && decisions(calls),
  ensures: (calls, completed) => settled(calls, completed) === (calls[0] ?? "none"),
});

export const acknowledgedOnCompletion = forall(settled, {
  when: (calls) => calls.length === 0,
  ensures: (calls, completed) => settled(calls, completed) === (completed ? "ack" : "none"),
});

export const handledExactly = forall(settled, {
  when: (calls) => decisions(calls),
  ensures: (calls, completed) =>
    handled(settled(calls, completed)) ===
    (calls.length === 0 ? completed : (calls[0] ?? "none") === "ack"),
});

export const onlyTheFirstTakesEffect = forall(standingAfter, {
  when: (standing, calls) => standing === "none" && decisions(calls),
  ensures: (standing, calls) =>
    takesEffect(standingAfter(standing, calls)) === (calls.length === 0),
});
