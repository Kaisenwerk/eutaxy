/**
 * The skeleton of a delivery, written once for every platform: user code
 * runs as an invocation under the engine's settle, and how it ended is one
 * of three outcomes rather than an exception to sort.
 */

import type { Invocation, RunHooks } from "@eutaxy/core";
import { CrashSignal } from "./run.ts";

/** How user code run as an invocation ended: it returned, it threw, or an injected fault crashed it. */
export type Outcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "errored"; readonly error: unknown }
  | { readonly status: "crashed" };

/**
 * Run user code as an invocation: under `RunHooks.settle` (real I/O
 * completes, timers fire while it is idle) and ended as "crashed" when an
 * injected fault crashes the invocation, whether the code saw the crash as
 * a `CrashSignal` or an effect of its hung, as "errored" when it threw
 * anything else.
 */
export async function runInvocation<T>(
  hooks: RunHooks,
  inv: Invocation,
  work: () => T | Promise<T>,
): Promise<Outcome<T>> {
  const outcome: Promise<Outcome<T>> = Promise.resolve()
    .then(work)
    .then(
      (value) => ({ status: "completed", value }),
      (error: unknown) =>
        error instanceof CrashSignal ? { status: "crashed" } : { status: "errored", error },
    );
  return Promise.race([
    hooks.settle(outcome, inv.id),
    inv.crashed.then((): Outcome<T> => ({ status: "crashed" })),
  ]);
}
