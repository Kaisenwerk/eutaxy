/**
 * Queue delivery: one invocation per delivery of a message, redelivered
 * until acked or dead-lettered. Which call takes effect, when the
 * platform acknowledges for the handler and whether the delivery was
 * handled are the rule of queue-decision.ts, whose claims are proved;
 * this file decides none of them itself.
 */

import {
  type DeliveryResult,
  decisionFaults,
  type EffectPoint,
  type EventRef,
  type JsonValue,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { decide, note, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import {
  acknowledgedImplicitly,
  type Decision,
  handled,
  type Standing,
  standsAfter,
  takesEffect,
} from "./queue-decision.ts";
import type { QueueDrive } from "./scenario.ts";

/** Deep-copy JSON data so a handler that mutates its message cannot leak into other runs. */
export function cloneJson(value: JsonValue): JsonValue {
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
  /** The decision that stands for the message: Cloudflare honours the first, and later ones are ignored. */
  const state: { standing: Standing } = { standing: "none" };
  const background: Promise<unknown>[] = [];

  const decisionPoint = (op: Decision, args: JsonValue): EffectPoint => ({
    invocation,
    target: queueTarget,
    op,
    args,
    allowed: decisionFaults,
  });
  /** The first decision wins; a later one is recorded as not effective. */
  const take = (op: Decision) => (): boolean => {
    const effective = takesEffect(state.standing);
    state.standing = standsAfter(state.standing, op);
    return effective;
  };
  const effective = (e: boolean): JsonValue => ({ effective: e });
  /** Records the handler's call; the result says whether it took effect. */
  const record = (op: Decision, args: JsonValue): void => {
    hooks.effectSync(decisionPoint(op, args), take(op), effective);
  };
  const message: Message<unknown> = {
    id: event.id,
    timestamp: new Date(),
    body: cloneJson(event.data),
    attempts: event.attempt,
    ack: () => record("ack", { messageId: event.id, implicit: false, body: event.data }),
    retry: () => record("retry", { messageId: event.id, body: event.data }),
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

  if (acknowledgedImplicitly(status === "completed", state.standing)) {
    const implicit = decisionPoint("ack", {
      messageId: event.id,
      implicit: true,
      body: event.data,
    });
    if (decide(hooks, implicit, take("ack"), effective) === "crashed") status = "crashed";
  }

  if (await drainBackground(hooks, inv, invocation, queueTarget, background)) status = "crashed";

  const followUps: EventRef[] = [];
  if (!handled(state.standing)) {
    const next = redelivery(event, maxRetries, spec.bounds);
    if (next) {
      followUps.push(next);
    } else {
      note(hooks, {
        invocation: hooks.bookkeeping(),
        target: queueTarget,
        op: "dead_letter",
        args: { messageId: event.id, attempts: event.attempt },
        allowed: [],
      });
    }
  }
  return { status, followUps };
}
