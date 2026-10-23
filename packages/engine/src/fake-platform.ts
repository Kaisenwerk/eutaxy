/**
 * An in-memory platform for engine tests: a "queue" whose consumer writes
 * rows into a map and acknowledges each message. Mirrors the shape of the
 * Cloudflare platform without workerd, so the engine's behaviour (injection,
 * crashes, redelivery, replay) can be tested as pure logic.
 */

import type {
  DeliveryResult,
  EventRef,
  JsonValue,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal } from "./run.ts";

export interface FakeMessage {
  readonly id: string;
  readonly body: JsonValue;
  ack(): void;
}

export interface FakeEnv {
  insert(orderId: string): Promise<{ changes: number }>;
}

export type FakeHandler = (message: FakeMessage, env: FakeEnv) => Promise<void>;

/** The planted bug: insert, then ack. */
export const buggyConsumer: FakeHandler = async (message, env) => {
  const body = message.body as { orderId: string };
  await env.insert(body.orderId);
  message.ack();
};

export function createFakePlatform(
  handler: FakeHandler,
  options: { idempotent?: boolean; maxRetries?: number } = {},
): Platform & {
  readonly rows: Map<string, number>;
} {
  const rows = new Map<string, number>();
  const maxRetries = options.maxRetries ?? 3;
  return {
    name: "fake",
    assumptions: ["fake in-memory platform"],
    rows,
    async reset() {
      rows.clear();
    },
    async finish(_spec, hooks) {
      const inv = hooks.startInvocation("platform");
      const payments = [...rows.entries()].sort().map(([order_id, count]) => ({ order_id, count }));
      hooks.snapshot(inv.id, "D1:DB", { tables: { payments } });
    },
    restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec {
      const messages = spec.drive["messages"] as readonly { id: string; body: JsonValue }[];
      return {
        ...spec,
        drive: { ...spec.drive, messages: messages.filter((m) => keepIds.includes(m.id)) },
      };
    },
    initialEvents(spec: ScenarioSpec): readonly EventRef[] {
      const messages = spec.drive["messages"] as readonly { id: string; body: JsonValue }[];
      return messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    },
    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const invocation = `${event.id}#${event.attempt}`;
      const inv = hooks.startInvocation(invocation);
      let acked = false;
      const env: FakeEnv = {
        insert: (orderId) =>
          hooks.effect(
            {
              invocation,
              target: "D1:DB",
              op: "run",
              args: { sql: "INSERT", params: [orderId] },
              allowed: ["crash_before", "crash_after", "ambiguous", "error"],
            },
            async () => {
              const before = rows.get(orderId) ?? 0;
              if (options.idempotent && before > 0) return { changes: 0 };
              rows.set(orderId, before + 1);
              return { changes: 1 };
            },
            (r) => ({ changes: r.changes }),
          ),
      };
      const message: FakeMessage = {
        id: event.id,
        body: event.data,
        ack: () =>
          hooks.effectSync(
            {
              invocation,
              target: "Queue:q",
              op: "ack",
              args: { messageId: event.id },
              allowed: ["crash_before", "crash_after"],
            },
            () => {
              acked = true;
            },
            () => null,
          ),
      };
      const outcome = Promise.resolve()
        .then(() => handler(message, env))
        .then(
          () => "completed" as const,
          (err) => (err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const)),
        );
      const status = await Promise.race([
        hooks.settle(outcome, invocation),
        inv.crashed.then(() => "crashed" as const),
      ]);
      const followUps: EventRef[] = [];
      if (
        !acked &&
        event.attempt <= maxRetries &&
        event.attempt - 1 < spec.bounds.maxRedeliveries
      ) {
        followUps.push({ ...event, attempt: event.attempt + 1 });
      }
      return { status, followUps };
    },
  };
}
