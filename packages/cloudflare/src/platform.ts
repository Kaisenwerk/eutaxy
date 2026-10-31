/**
 * The Cloudflare platform: delivers queue messages to the Worker's `queue()`
 * handler and inbound requests to its `fetch()` handler, with proxied
 * bindings, and applies Queues' at-least-once semantics (explicit and
 * implicit ack, retry, redelivery up to max_retries, dead-lettering) as
 * documented by Cloudflare, and for requests the caller's retry policy
 * declared in the drive.
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
import type { RunningWorker } from "./background.ts";
import {
  type Binding,
  d1Binding,
  durableObjectBinding,
  ownedSetups,
  r2Binding,
  workflowBinding,
} from "./bindings.ts";
import type { ProxyContext } from "./d1.ts";
import type { DurableObjectTestHelpers } from "./durable-objects.ts";
import { deliverRequest } from "./http.ts";
import { deliverMessage } from "./queues.ts";
import type { HttpDrive, QueueDrive } from "./scenario.ts";

/** The Worker's default export, as far as the platform drives it. */
export interface WorkerHandler {
  queue?(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): void | Promise<void>;
  fetch?(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface CloudflarePlatformOptions {
  /** The bindings from `cloudflare:workers`. */
  readonly env: object;
  /** The Worker's default export. */
  readonly handler: WorkerHandler;
  /** Schema SQL per D1 binding named in the scenario's setup. */
  readonly schemas: Readonly<Record<string, string>>;
  /** Cloudflare's default when the consumer does not set max_retries. */
  readonly maxRetries?: number;
  /**
   * The Cloudflare Vitest plugin's test helpers (`import * as helpers from
   * "cloudflare:test"`), needed for Durable Object bindings: Eutaxy resets,
   * seeds and snapshots the real objects through them.
   */
  readonly durableObjects?: DurableObjectTestHelpers;
  /**
   * The Worker module's exports (`import * as worker from "./worker.ts"`),
   * where the classes `workflow` setup steps name are found.
   */
  readonly exports?: Readonly<Record<string, unknown>>;
}

function isBindingLike(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  const names = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertyNames(proto ?? {})];
  return names.some(
    (k) => k !== "constructor" && typeof (value as Record<string, unknown>)[k] === "function",
  );
}

const assumptions: readonly string[] = [
  "platform model: Cloudflare Queues at-least-once delivery; the first ack or retry decision per message wins; unacked messages are redelivered up to max_retries then dead-lettered",
  "D1 statements run against Miniflare's SQLite; each run/first/all/raw/batch/exec is one effect",
  "message.timestamp is the virtual clock's time at delivery",
  "only D1, Durable Object, R2 and Workflow bindings are proxied; touching any other binding makes the run UNSUPPORTED",
  "R2 buckets are Miniflare's real ones, emptied and seeded before each run and snapshotted after it; R2 is strongly consistent and the last writer wins (developers.cloudflare.com/r2/reference/consistency/); each put, delete, get, head and list is one effect, a body is read inside its get, and an object's version and upload time are stand-ins so traces repeat; multipart uploads and conditions on the upload time are not modelled",
  "Durable Objects are the real objects workerd runs (storage, transactions, input and output gates are the runtime's own); each stub call is one effect: crash_before or error means it never reached the object, ambiguous means the object committed and the caller lost the answer, crash_after means the caller died after it; in a concurrent run an object's own outbound I/O during a call is a turn, so another event may enter the object meanwhile (its input gate is open then), except while it holds the gate with blockConcurrencyWhile, when its effects run at once; storage operations are not turns (the input gate holds other events during them); the object's own binding calls are not recorded; objects are cleared, seeded and evicted before each run and their storage is snapshotted after it (developers.cloudflare.com/durable-objects/api/storage-api/)",
  "Durable Object alarms are taken over so none is scheduled on the real clock and fire in virtual time: one alarm per object, a later setAlarm replaces it, setAlarm in a transaction applies on commit, the alarm survives eviction, alarm() is one effect (crash_before: it never ran; crash_after: it ran and counts as failed; error: it threw), and a failed alarm is retried after 2 s, 4 s, 8 s ... up to six retries and maxRedeliveries, with retryCount and isRetry (developers.cloudflare.com/durable-objects/api/base/#alarm); each object's alarm fires at most alarmsPerObject times per run (default 3)",
  "Workflows are a model of the engine, never the local one, running the scenario's own class: create is one effect that queues the instance; each step.do attempt is two effect points around its callback, which runs as the instance's own code (step, crash_before: the engine restarts before it; step_result, crash_after: it ran and committed but its result was not persisted, so it runs again; ambiguous: the attempt ran but counted as failed, as a timeout does); a failed attempt is retried after its delay in virtual time (defaults 5 retries, 10 s, exponential, merged field by field with a step's config), up to its limit and maxRedeliveries, except a NonRetryableError; a restart re-runs run() from the start with the persisted step and sleep results, so code outside steps repeats; step timeouts are not measured (developers.cloudflare.com/workflows/build/rules-of-workflows/, /workflows/build/sleeping-and-retrying/)",
  "state invariants read a snapshot of every D1 binding named in setup, taken after the last event",
  "work passed to ctx.waitUntil runs after the handler returns and never affects acknowledgement or the response; a cut_off fault at that point loses work not yet started, and an effect in flight commits without its continuation",
  "concurrent invocations (maxConcurrentInvocations above 1) share one isolate's module state and bindings, and another may run while one awaits I/O (developers.cloudflare.com/workers/reference/how-workers-works/); queue consumers run concurrently up to max_concurrency (developers.cloudflare.com/queues/configuration/consumer-concurrency/)",
  "inbound requests: one invocation per attempt; an uncaught exception is a 500 response; the drive's caller resends a request it got no acceptable response for (crash before the response, an answer after its deadlineMs, or a status its retryOn policy rejects) up to its retries, each resend after its delaysMs entry of virtual time; the handler's own time is virtual, so a late answer is the ambiguous fault at the response point or an answer later than deadlineMs in virtual time",
];

export function createCloudflarePlatform(options: CloudflarePlatformOptions): Platform {
  const env = options.env as Record<string, unknown>;
  const maxRetries = options.maxRetries ?? 3;
  let hooksRef: RunHooks | null = null;

  const ctx: ProxyContext = {
    get hooks() {
      if (!hooksRef) throw new Error("no run in progress");
      return hooksRef;
    },
    // Bindings are shared by every invocation in flight; the engine knows which one is running.
    currentInvocation: () => ctx.hooks.running(),
  };

  /** The kinds of binding modelled, in the order an env value is tried against them. */
  const bindings: readonly Binding[] = [
    d1Binding(options.schemas),
    durableObjectBinding({ ctx, helpers: options.durableObjects, real: (name) => env[name] }),
    r2Binding(),
    workflowBinding({ exports: options.exports, env: () => proxiedEnv }),
  ];
  const proxiedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string") return value;
      for (const binding of bindings) if (binding.is(value)) return binding.proxy(prop, value, ctx);
      if (isBindingLike(value)) ctx.hooks.unsupported(`binding ${prop} is not proxied`);
      return value;
    },
  });
  const worker: RunningWorker = { handler: options.handler, env: proxiedEnv };

  return {
    name: "cloudflare",
    assumptions,
    concurrent: true,

    async reset(spec: ScenarioSpec): Promise<void> {
      for (const binding of bindings) binding.clear();
      for (const [binding, setup] of ownedSetups(spec.setup, bindings))
        await binding.reset(setup, env[setup.binding]);
    },

    restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec {
      const drive = spec.drive as QueueDrive | HttpDrive;
      if (drive.kind === "http") {
        return {
          ...spec,
          drive: { ...drive, requests: drive.requests.filter((r) => keepIds.includes(r.id)) },
        };
      }
      return {
        ...spec,
        drive: { ...drive, messages: drive.messages.filter((m) => keepIds.includes(m.id)) },
      };
    },

    async finish(spec: ScenarioSpec, hooks: RunHooks): Promise<void> {
      for (const [binding, setup] of ownedSetups(spec.setup, bindings)) {
        const tables = await binding.snapshot(setup, env[setup.binding], (reason) =>
          hooks.unsupported(reason),
        );
        if (tables)
          hooks.snapshot(hooks.bookkeeping(), `${binding.target}:${setup.binding}`, { tables });
      }
    },

    initialEvents(spec: ScenarioSpec): readonly EventRef[] {
      const drive = spec.drive as QueueDrive | HttpDrive;
      if (drive.kind === "http") {
        return drive.requests.map((r) => ({
          id: r.id,
          attempt: 1,
          data: r as unknown as JsonValue,
        }));
      }
      return drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    },

    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const drive = spec.drive as QueueDrive | HttpDrive;
      const invocation = invocationOf(event);
      hooksRef = hooks;
      // An event of a binding's own (an alarm, a Workflow run) is the binding's to deliver.
      const owner =
        event.source === undefined ? undefined : bindings.find((b) => b.source === event.source);
      if (owner?.deliver) return owner.deliver(event, hooks, spec);
      return drive.kind === "http"
        ? await deliverRequest(event, hooks, spec, drive, invocation, worker)
        : await deliverMessage(event, hooks, spec, drive, invocation, worker, maxRetries);
    },
  };
}
