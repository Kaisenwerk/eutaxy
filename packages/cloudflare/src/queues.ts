/** Queue delivery: one invocation per delivery of a message, redelivered until acked or dead-lettered. */

import {
  type DeliveryResult,
  decisionFaults,
  type EventRef,
  type JsonValue,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import type { QueueDrive } from "./scenario.ts";

/** Deep-copy JSON data so a handler that mutates its message cannot leak into other runs. */
function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** One delivery of a queue message, with Queues' at-least-once semantics. */
export async function deliverMessage(
  event: EventRef,
  hooks: RunHooks,
  spec: ScenarioSpec,
  drive: QueueDrive,
  invocation: string,
  worker: RunningWorker,
  maxRetries: number,
): Promise<DeliveryResult> {
  const queueTarget = `Queue:${drive.queue}`;
  const inv = hooks.startInvocation(invocation);
  /** Cloudflare honours the first ack or retry decision per message; later ones are ignored. */
  const state: { decision: "ack" | "retry" | null } = { decision: null };
  const background: Promise<unknown>[] = [];

  /** Records the call; the result says whether it took effect (the first decision wins). */
  const decide = (op: "ack" | "retry", args: JsonValue): void => {
    hooks.effectSync(
      { invocation, target: queueTarget, op, args, allowed: decisionFaults },
      () => {
        if (state.decision !== null) return false;
        state.decision = op;
        return true;
      },
      (effective) => ({ effective }),
    );
  };
  const message: Message<unknown> = {
    id: event.id,
    timestamp: new Date(),
    body: cloneJson(event.data),
    attempts: event.attempt,
    ack: () => decide("ack", { messageId: event.id, implicit: false, body: event.data }),
    retry: () => decide("retry", { messageId: event.id, body: event.data }),
  };
  const batch: MessageBatch<unknown> = {
    queue: drive.queue,
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => message.ack(),
    retryAll: () => message.retry(),
  };
  const execution = executionContext(background);

  const handler = worker.handler.queue;
  if (!handler) throw new Error("the Worker has no queue() handler");
  let status: DeliveryResult["status"] = (
    await runInvocation(hooks, inv, () =>
      handler.call(worker.handler, batch, worker.env, execution),
    )
  ).status;

  if (status === "completed" && state.decision === null) {
    try {
      decide("ack", { messageId: event.id, implicit: true, body: event.data });
    } catch (err) {
      if (err instanceof CrashSignal) status = "crashed";
      else throw err;
    }
  }

  if (await drainBackground(hooks, inv, invocation, queueTarget, background)) status = "crashed";

  const followUps: EventRef[] = [];
  if (state.decision !== "ack") {
    const next = redelivery(event, maxRetries, spec.bounds);
    if (next) {
      followUps.push(next);
    } else {
      hooks.effectSync(
        {
          invocation: hooks.bookkeeping(),
          target: queueTarget,
          op: "dead_letter",
          args: { messageId: event.id, attempts: event.attempt },
          allowed: [],
        },
        () => null,
        () => null,
      );
    }
  }
  return { status, followUps };
}
