/**
 * Cron Trigger delivery: one invocation of the Worker's `scheduled()` handler
 * per tick attempt, with `scheduledTime` the tick's virtual time and `cron`
 * the expression (Workers, Scheduled handler). Cloudflare documents
 * `noRetry()` but no retry count, so the drive declares how many times a
 * tick whose handler failed is re-run; `noRetry()` stops them.
 */

import {
  type DeliveryResult,
  decisionFaults,
  type EventRef,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import type { CronDrive } from "./scenario.ts";

/** What a tick event carries: what the controller shows the handler. */
export interface TickData {
  readonly cron: string;
  readonly scheduledTime: number;
}

/** One attempt of a tick: the handler runs, and a failure is re-run as the drive declares unless it said noRetry(). */
export async function deliverTick(
  event: EventRef,
  hooks: RunHooks,
  spec: ScenarioSpec,
  drive: CronDrive,
  invocation: string,
  worker: RunningWorker,
): Promise<DeliveryResult> {
  const tick = event.data as unknown as TickData;
  const target = `Cron:${drive.cron}`;
  const inv = hooks.startInvocation(invocation);
  const background: Promise<unknown>[] = [];
  /** Rejections of waitUntil work: the first one is the invocation's status (Cloudflare, Scheduled handler). */
  const failures: unknown[] = [];
  const handler = worker.handler.scheduled;
  if (!handler) throw new Error("the Worker has no scheduled() handler");
  let noRetry = false;
  const controller: ScheduledController = {
    scheduledTime: tick.scheduledTime,
    cron: tick.cron,
    // A decision the runtime honours, like a queue ack: a crash around it may lose or keep it.
    noRetry: () => {
      hooks.effectSync(
        { invocation, target, op: "no_retry", args: { tick: event.id }, allowed: decisionFaults },
        () => {
          noRetry = true;
          return null;
        },
        () => null,
      );
    },
  };
  let status: DeliveryResult["status"] = (
    await runInvocation(hooks, inv, () =>
      handler.call(worker.handler, controller, worker.env, executionContext(background, failures)),
    )
  ).status;
  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  if (status === "completed" && failures.length > 0) status = "errored";

  const followUps: EventRef[] = [];
  if (status !== "completed" && !noRetry) {
    // The re-run is the same tick: same scheduledTime, next attempt.
    const next = redelivery(event, drive.retries, spec.bounds);
    if (next) followUps.push(next);
    else
      hooks.effectSync(
        {
          invocation: hooks.bookkeeping(),
          target,
          op: "gave_up",
          args: { tick: event.id, attempts: event.attempt },
          allowed: [],
        },
        () => null,
        () => null,
      );
  }
  return { status, followUps };
}
