/**
 * The skeleton of a delivery, written once for every platform: user code
 * runs as an invocation under the engine's settle, and how it ended is one
 * of three outcomes rather than an exception to sort.
 */

import type { EffectPoint, Invocation, JsonValue, RunHooks } from "@eutaxy/core";
import { CrashSignal, Run } from "./run.ts";

/** How user code run as an invocation ended: it returned, it threw, or an injected fault crashed it. */
export type Outcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "errored"; readonly error: unknown }
  | { readonly status: "crashed" };

/**
 * Run user code as an invocation: under `RunHooks.settle` (real I/O
 * completes, timers fire while it is idle) and ended as "crashed" when an
 * injected fault crashes the invocation, whether the code saw the crash as
 * a `CrashSignal`, an effect of its hung (the settle then rejects with the
 * signal, on the run's own tick), the invocation's `crashed` settled, or
 * the code returned or threw anything else after the crash (an object's
 * reset rejecting the call into it with an error of the runtime's); as
 * "errored" when it threw anything else.
 */
export async function runInvocation<T>(
  hooks: RunHooks,
  inv: Invocation,
  work: () => T | Promise<T>,
): Promise<Outcome<T>> {
  const crashed: Outcome<T> = { status: "crashed" };
  const outcome: Promise<Outcome<T>> = Promise.resolve()
    .then(work)
    .then(
      (value) => (inv.isCrashed() ? crashed : { status: "completed", value }),
      (error: unknown) =>
        error instanceof CrashSignal || inv.isCrashed() ? crashed : { status: "errored", error },
    );
  return Promise.race([
    hooks
      .settle(outcome, inv.id)
      .catch((error: unknown) =>
        error instanceof CrashSignal ? crashed : Promise.reject<Outcome<T>>(error),
      ),
    inv.crashed.then(() => crashed),
  ]);
}

/**
 * Run user code as an invocation of its own inside the effect being performed
 * (a called Worker's code inside the call's effect). The engine attributes
 * the effects `work` makes to `id` and schedules them as turns of their own,
 * has the hosting effect wait on the work without counting as I/O, and makes
 * the hosting invocation the running one again afterwards. `work` runs the
 * user code through `runInvocation` (and whatever follows it, such as
 * background work) so that it ends as an outcome; a fault that crashes `id`
 * ends `id` alone, and what the hosting code then throws or returns is the
 * platform's to decide.
 */
export function hostInvocation<T>(
  hooks: RunHooks,
  id: string,
  work: (inv: Invocation) => Promise<T>,
): Promise<T> {
  if (!(hooks instanceof Run)) throw new Error("hostInvocation needs the engine's run");
  return hooks.hosted(id, work);
}

/**
 * Record a platform action that performs nothing: a marker in the log (a
 * message dead-lettered, a caller that gave up, a Workflow step's result).
 * Under faults it can crash the invocation like any effect; most admit none.
 */
export function note(hooks: RunHooks, point: EffectPoint): void {
  hooks.effectSync(
    point,
    () => null,
    () => null,
  );
}

/**
 * Perform a decision of the platform's own (an implicit ack, a delete)
 * under the faults around a decision: it stands, or an injected crash
 * ended the invocation at that point.
 */
export function decide<T>(
  hooks: RunHooks,
  point: EffectPoint,
  perform: () => T,
  summarize: (value: T) => JsonValue,
): "decided" | "crashed" {
  try {
    hooks.effectSync(point, perform, summarize);
    return "decided";
  } catch (err) {
    if (err instanceof CrashSignal) return "crashed";
    throw err;
  }
}
