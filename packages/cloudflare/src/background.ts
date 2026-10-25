/** What a delivery hands the Worker besides the event: its `ExecutionContext`, and the background work it collects. */

import type { FaultKind, RunHooks } from "@eutaxy/core";
import { CrashSignal } from "@eutaxy/engine";
import type { WorkerHandler } from "./platform.ts";

const CUT_OFF: readonly FaultKind[] = ["cut_off"];

/** The Worker a delivery runs: its default export and the proxied bindings it sees. */
export interface RunningWorker {
  readonly handler: WorkerHandler;
  readonly env: object;
}

/** The `ExecutionContext` handed to a handler; `waitUntil` work is collected to run after it returns. */
export function executionContext(background: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      background.push(
        promise.then(
          () => undefined,
          () => undefined,
        ),
      );
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

/**
 * Background work extends the invocation but never changes the acknowledgement or the response.
 * A cut-off here is the isolate dying after them: work not yet started is lost.
 */
export async function drainBackground(
  hooks: RunHooks,
  inv: { isCrashed(): boolean; readonly crashed: Promise<void> },
  invocation: string,
  target: string,
  background: readonly Promise<unknown>[],
): Promise<boolean> {
  if (background.length === 0 || inv.isCrashed()) return false;
  try {
    hooks.effectSync(
      {
        invocation,
        target,
        op: "background",
        args: { pending: background.length },
        allowed: CUT_OFF,
      },
      () => null,
      () => null,
    );
    await Promise.race([hooks.settle(Promise.all(background), invocation), inv.crashed]);
    return false;
  } catch (err) {
    if (!(err instanceof CrashSignal)) throw err;
    return true;
  }
}
