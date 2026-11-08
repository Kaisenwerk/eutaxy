/**
 * The caller of an inbound request or RPC call. Cloudflare retries neither,
 * so resends follow the policy the drive declares for the caller: how many
 * times it resends, the virtual delay before each resend, and how long it
 * waits for an answer. The decision is the caller's and is made once per
 * attempt: at the response point, or at its deadline if the handler has
 * not answered by then.
 */

import {
  type EventRef,
  type FaultKind,
  type JsonValue,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal, InjectedEffectError, note } from "@eutaxy/engine";

/** The response point: a crash before it is a response the caller never saw. */
const RESPOND: readonly FaultKind[] = ["crash_before"];
/**
 * With a caller deadline the answer can also arrive too late: `ambiguous`
 * here means it was sent, the caller counted it as failed, and the handler
 * carried on.
 */
const RESPOND_WITH_DEADLINE: readonly FaultKind[] = ["crash_before", "ambiguous"];

/** What a drive declares about its caller. */
export interface CallerPolicy {
  /** Resends after the first attempt. */
  readonly retries: number;
  /** Virtual time the caller waits before resend number i + 1; the last entry repeats, none means at once. */
  readonly delaysMs?: readonly number[];
  /** How long the caller waits for an answer; one that comes later counts as failed. */
  readonly deadlineMs?: number;
}

/** The virtual delay before resend number `resend` (1 for the first), per the policy. */
export function retryDelayMs(policy: Pick<CallerPolicy, "delaysMs">, resend: number): number {
  const delays = policy.delaysMs ?? [];
  return delays[Math.min(resend, delays.length) - 1] ?? 0;
}

/** How an attempt ended for its caller: an answer the handler sent, the answer an uncaught error gets, or none. */
export type Answer =
  | { readonly kind: "answered"; readonly value: JsonValue; readonly accepted: boolean }
  | { readonly kind: "errored"; readonly value: JsonValue }
  | { readonly kind: "none" };

/** One attempt's caller, waiting for its answer. */
export interface Caller {
  /**
   * The response point: the answer is recorded as the `response` effect under
   * the caller's faults (an injected crash is the handler's, before the send;
   * an injected error is an answer sent after the deadline, which the caller
   * counts as failed while the handler carries on), a synthetic answer for an
   * uncaught error under none, and the caller settles. Whether the invocation
   * crashed at the point.
   */
  respond(invocation: string, args: JsonValue, answer: Answer): boolean;
}

/**
 * Start waiting for the attempt's answer. With a deadline, a virtual timer
 * makes the caller give up at it whatever the handler is doing, so a resend
 * can start while the first attempt still runs. `gaveUp` is what the
 * `gave_up` effect records when the retries are spent.
 */
export function startCaller(
  event: EventRef,
  hooks: RunHooks,
  spec: ScenarioSpec,
  policy: CallerPolicy,
  target: string,
  gaveUp: JsonValue,
): Caller {
  // Virtual time: when the caller sent this attempt, for its deadline.
  const started = Date.now();
  const deadline = policy.deadlineMs;
  // The caller gives up at its deadline even when the answer comes later still.
  const lateAt = deadline === undefined ? undefined : started + deadline;

  /** The caller decides once: it accepts the answer, or gives up at `at` and resends or stops. */
  let decided = false;
  const giveUp = (at: number): void => {
    if (decided) return;
    decided = true;
    const next = redelivery(event, policy.retries, spec.bounds);
    if (next) {
      const resendAt = Math.max(at + retryDelayMs(policy, event.attempt), Date.now());
      hooks.enqueue({ ...next, ...(resendAt > Date.now() ? { at: resendAt } : {}) });
    } else {
      note(hooks, {
        invocation: hooks.bookkeeping(),
        target,
        op: "gave_up",
        args: gaveUp,
        allowed: [],
      });
    }
  };
  // A virtual timer: at the deadline the caller gives up, whatever the handler is doing.
  const deadlineTimer =
    lateAt === undefined ? undefined : setTimeout(() => giveUp(lateAt), deadline);

  const responseFaults = deadline === undefined ? RESPOND : RESPOND_WITH_DEADLINE;
  const isLate = (): boolean => lateAt !== undefined && Date.now() > lateAt;
  /** The caller decides as soon as it has an answer or gives up, before background work ends. */
  const settle = (accepted: boolean, late: boolean): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (accepted) decided = true;
    else giveUp(late && lateAt !== undefined ? lateAt : Date.now());
  };

  return {
    respond(invocation, args, answer) {
      let late = isLate();
      let accepted = false;
      let crashed = false;
      const record = (allowed: readonly FaultKind[], value: JsonValue): void => {
        hooks.effectSync(
          { invocation, target, op: "response", args, allowed },
          () => value,
          (v) => v,
        );
      };
      if (answer.kind === "answered") {
        try {
          record(responseFaults, answer.value);
          accepted = answer.accepted;
        } catch (err) {
          if (err instanceof CrashSignal) crashed = true;
          else if (err instanceof InjectedEffectError) late = true;
          else throw err;
        }
      } else if (answer.kind === "errored") {
        record([], answer.value);
      }
      settle(accepted && !late, late);
      return crashed;
    },
  };
}
