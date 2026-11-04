/**
 * An in-memory platform for engine tests: a "queue" whose consumer writes
 * rows into a map and acknowledges each message. Mirrors the shape of the
 * Cloudflare platform without workerd, so the engine's behaviour (injection,
 * crashes, redelivery, replay) can be tested as pure logic.
 */

import {
  type DeliveryResult,
  type EventRef,
  invocationOf,
  type JsonValue,
  type Platform,
  type RunHooks,
  type ScenarioSpec,
} from "@eutaxy/core";
import { hostInvocation, runInvocation } from "./deliver.ts";
import { CrashSignal } from "./run.ts";

export interface FakeMessage {
  readonly id: string;
  readonly body: JsonValue;
  ack(): void;
}

export interface FakeEnv {
  insert(orderId: string): Promise<{ changes: number }>;
  /** How many rows the order has; a read, so it is an effect point too. */
  count(orderId: string): Promise<number>;
}

export type FakeHandler = (message: FakeMessage, env: FakeEnv) => Promise<void>;

/** The planted bug: insert, then ack. */
export const buggyConsumer: FakeHandler = async (message, env) => {
  const body = message.body as { orderId: string };
  await env.insert(body.orderId);
  message.ack();
};

/** Check, then insert: correct one at a time, a duplicate when two deliveries interleave. */
export const checkThenInsertConsumer: FakeHandler = async (message, env) => {
  const body = message.body as { orderId: string };
  if ((await env.count(body.orderId)) === 0) await env.insert(body.orderId);
  message.ack();
};

export function createFakePlatform(
  handler: FakeHandler,
  options: {
    idempotent?: boolean;
    maxRetries?: number;
    concurrent?: boolean;
    /** An order whose insert never completes, like a binding call that hangs. */
    hangInsert?: string;
    /** The insert reads first inside its own effect, like an object that calls out during a call. */
    nestedRead?: boolean;
    /** Called inside every insert's effect, while its I/O is still pending. */
    duringInsert?: () => void;
    /** Mark the insert as hosting effects, like a Durable Object call. */
    insertHosts?: boolean;
    /** The insert checks for the row itself and calls out before writing, like an object's method. */
    checkInside?: boolean;
    /** The insert makes two reads at once inside it, like an object awaiting two fetches together. */
    parallelInside?: boolean;
    /**
     * The insert is a call to another Worker (`Service:CALLEE`) whose code runs as an invocation of
     * its own inside the call, and writes through its own binding (`D1:callee/DB`).
     */
    viaCallee?: boolean;
    /** The callee sleeps on a virtual timer before writing. */
    calleeSleeps?: boolean;
    /** The callee reads the count first, as its own effect, and writes only when it saw no row. */
    calleeChecks?: boolean;
  } = {},
): Platform & {
  readonly rows: Map<string, number>;
} {
  const rows = new Map<string, number>();
  const maxRetries = options.maxRetries ?? 3;
  return {
    name: "fake",
    assumptions: ["fake in-memory platform"],
    concurrent: options.concurrent ?? false,
    rows,
    async reset() {
      rows.clear();
    },
    async finish(_spec, hooks) {
      const payments = [...rows.entries()].sort().map(([order_id, count]) => ({ order_id, count }));
      hooks.snapshot(hooks.bookkeeping(), "D1:DB", { tables: { payments } });
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
      const invocation = invocationOf(event);
      const inv = hooks.startInvocation(invocation);
      let acked = false;
      /** The write itself, under the binding `target` names. */
      const write = (orderId: string, target: string) =>
        hooks.effect(
          {
            // Like a binding proxy shared by every invocation: the engine says whose code called.
            invocation: hooks.running(),
            target,
            op: "run",
            args: { sql: "INSERT", params: [orderId] },
            allowed: ["crash_before", "crash_after", "ambiguous", "error"],
            ...(options.insertHosts ? { hostsEffects: true } : {}),
          },
          async () => {
            if (orderId === options.hangInsert) await new Promise(() => {});
            if (options.nestedRead) await env.count(orderId);
            if (options.parallelInside) await Promise.all([env.count(orderId), env.count(orderId)]);
            if (options.checkInside) {
              // Like an object: read its own state, call out (the nested read), then write on what it read.
              const seen = rows.get(orderId) ?? 0;
              await env.count(orderId);
              if (seen > 0) return { changes: 0 };
            }
            if (options.duringInsert) {
              options.duringInsert();
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            const before = rows.get(orderId) ?? 0;
            if (options.idempotent && before > 0) return { changes: 0 };
            rows.set(orderId, before + 1);
            return { changes: 1 };
          },
          (r) => ({ changes: r.changes }),
        );
      /** Calls into the callee so far from this delivery, to name each hosted invocation. */
      let calls = 0;
      /** The write as a call into another Worker, whose code is hosted inside the call's effect. */
      const viaCallee = (orderId: string) =>
        hooks.effect(
          {
            invocation: hooks.running(),
            target: "Service:CALLEE",
            op: "insert",
            args: { args: [orderId] },
            allowed: ["crash_before", "ambiguous", "crash_after"],
          },
          async () => {
            const n = ++calls;
            const id = `${hooks.running()}/CALLEE.insert${n === 1 ? "" : `#${n}`}`;
            const outcome = await hostInvocation(hooks, id, (inv) =>
              runInvocation(hooks, inv, async () => {
                if (options.calleeSleeps) await new Promise((r) => setTimeout(r, 50));
                if (options.calleeChecks && (await count(orderId, "D1:callee/DB")) > 0)
                  return { changes: 0 };
                return write(orderId, "D1:callee/DB");
              }),
            );
            if (outcome.status === "completed") return outcome.value;
            throw outcome.status === "errored" ? outcome.error : new Error("the callee crashed");
          },
          (r) => ({ changes: r.changes }),
        );
      const count = (orderId: string, target = "D1:DB") =>
        hooks.effect(
          {
            // Like a binding proxy shared by every invocation: the engine says whose code called.
            invocation: hooks.running(),
            target,
            op: "first",
            args: { sql: "SELECT", params: [orderId] },
            allowed: ["crash_before", "crash_after", "error"],
          },
          async () => rows.get(orderId) ?? 0,
          (n) => n,
        );
      const env: FakeEnv = {
        insert: (orderId) => (options.viaCallee ? viaCallee(orderId) : write(orderId, "D1:DB")),
        count: (orderId) => count(orderId),
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
