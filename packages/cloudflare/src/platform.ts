/**
 * The Cloudflare platform: delivers queue messages to the Worker's `queue()`
 * handler and inbound requests to its `fetch()` handler, with proxied
 * bindings, and applies Queues' at-least-once semantics (explicit and
 * implicit ack, retry, redelivery up to max_retries, dead-lettering) as
 * documented by Cloudflare, and for requests the caller's retry policy
 * declared in the drive.
 */

import type {
  DeliveryResult,
  EventRef,
  JsonValue,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { alarmSource, deliverAlarm } from "./alarms.ts";
import type { RunningWorker } from "./background.ts";
import { type ProxyContext, proxyD1, resetD1, snapshotD1 } from "./d1.ts";
import {
  alarmRunner,
  BindingState,
  type DurableObjectTestHelpers,
  evictObject,
  isDurableObjectNamespace,
  proxyNamespace,
  resetNamespace,
  snapshotNamespace,
} from "./durable-objects.ts";
import { deliverRequest } from "./http.ts";
import { deliverMessage } from "./queues.ts";
import {
  type DurableObjectSetup,
  defaultAlarmsPerObject,
  type HttpDrive,
  type QueueDrive,
} from "./scenario.ts";

/** The Worker's default export, as far as the platform drives it. */
export interface WorkerHandler {
  queue?(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): void | Promise<void>;
  fetch?(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
}

/** The former name of `WorkerHandler`, kept for callers written against 0.1. */
export type QueueHandler = WorkerHandler;

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
}

function isD1(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function" &&
    typeof (value as { batch?: unknown }).batch === "function"
  );
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
  "only D1 and Durable Object bindings are proxied; touching any other binding makes the run UNSUPPORTED",
  "Durable Objects are the real objects workerd runs (storage, transactions, input and output gates are the runtime's own); each stub call is one effect: crash_before or error means it never reached the object, ambiguous means the object committed and the caller lost the answer, crash_after means the caller died after it; in a concurrent run an object's own outbound I/O during a call is a turn, so another event may enter the object meanwhile (its input gate is open then), except while it holds the gate with blockConcurrencyWhile, when its effects run at once; storage operations are not turns (the input gate holds other events during them); the object's own binding calls are not recorded; objects are cleared, seeded and evicted before each run and their storage is snapshotted after it (developers.cloudflare.com/durable-objects/api/storage-api/)",
  "Durable Object alarms are taken over so none is scheduled on the real clock and fire in virtual time: one alarm per object, a later setAlarm replaces it, setAlarm in a transaction applies on commit, the alarm survives eviction, alarm() is one effect (crash_before: it never ran; crash_after: it ran and counts as failed; error: it threw), and a failed alarm is retried after 2 s, 4 s, 8 s ... up to six retries and maxRedeliveries, with retryCount and isRetry (developers.cloudflare.com/durable-objects/api/base/#alarm); each object's alarm fires at most alarmsPerObject times per run (default 3)",
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

  const d1Proxies = new Map<string, D1Database>();
  const doProxies = new Map<string, DurableObjectNamespace>();
  /** The Durable Object bindings the current scenario's setup resets before each run. */
  let resetBindings = new Set<string>();
  /** Per binding, what the current run knows about its objects. */
  const bindingStates = new Map<string, BindingState>();
  const stateFor = (binding: string): BindingState => {
    let state = bindingStates.get(binding);
    if (!state) {
      state = new BindingState();
      bindingStates.set(binding, state);
    }
    return state;
  };
  /** Per binding, alarm firings allowed per object in the current run. */
  let alarmLimits = new Map<string, number>();
  const namespace = (binding: string): DurableObjectNamespace => {
    const real = env[binding];
    if (!isDurableObjectNamespace(real))
      throw new Error(`env.${binding} is not a Durable Object namespace`);
    return real;
  };
  const helpers = (): DurableObjectTestHelpers => {
    if (!options.durableObjects)
      throw new Error(
        'Durable Object setup needs the Cloudflare test helpers: createCloudflarePlatform({ ..., durableObjects: await import("cloudflare:test") })',
      );
    return options.durableObjects;
  };
  const proxiedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string") return value;
      if (isD1(value)) {
        let p = d1Proxies.get(prop);
        if (!p) {
          p = proxyD1(value, prop, ctx);
          d1Proxies.set(prop, p);
        }
        return p;
      }
      if (isDurableObjectNamespace(value)) {
        let p = doProxies.get(prop);
        if (!p) {
          p = proxyNamespace(value, prop, ctx, stateFor(prop), options.durableObjects, () =>
            resetBindings.has(prop),
          );
          doProxies.set(prop, p);
        }
        return p;
      }
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
      resetBindings = new Set(
        spec.setup.filter((s) => s.kind === "durable_object").map((s) => String(s["binding"])),
      );
      for (const state of bindingStates.values()) state.clear();
      alarmLimits = new Map(
        spec.setup
          .filter((s) => s.kind === "durable_object")
          .map((s) => [
            String(s["binding"]),
            (s as DurableObjectSetup).alarmsPerObject ?? defaultAlarmsPerObject,
          ]),
      );
      for (const step of spec.setup) {
        if (step.kind === "durable_object") {
          const setup = step as DurableObjectSetup;
          await resetNamespace(
            namespace(setup.binding),
            helpers(),
            stateFor(setup.binding).names,
            setup.objects,
          );
          continue;
        }
        if (step.kind !== "d1") continue;
        const binding = String(step["binding"]);
        const schema = options.schemas[binding];
        if (schema === undefined) throw new Error(`no schema provided for D1 binding ${binding}`);
        const real = env[binding];
        if (!isD1(real)) throw new Error(`env.${binding} is not a D1 binding`);
        await resetD1(real, schema);
      }
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
      for (const step of spec.setup) {
        if (step.kind === "durable_object") {
          const setup = step as DurableObjectSetup;
          const binding = setup.binding;
          const tables = await snapshotNamespace(
            namespace(binding),
            helpers(),
            stateFor(binding).names,
            stateFor(binding).touched,
            setup.objects,
            (object) =>
              hooks.unsupported(
                `Durable Object ${binding} ${object} was reached without a call Eutaxy saw (through another object's binding); calls between objects are not proxied yet`,
              ),
            (reason) => hooks.unsupported(reason),
          );
          hooks.snapshot(hooks.bookkeeping(), `DO:${binding}`, { tables });
          continue;
        }
        if (step.kind !== "d1") continue;
        const binding = String(step["binding"]);
        const real = env[binding];
        if (!isD1(real)) continue;
        const tables = await snapshotD1(real);
        hooks.snapshot(hooks.bookkeeping(), `D1:${binding}`, { tables });
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
      const invocation = `${event.id}#${event.attempt}`;
      hooksRef = hooks;
      if (event.source === alarmSource) {
        const binding = String((event.data as { binding?: unknown }).binding ?? "");
        return deliverAlarm(event, hooks, spec.bounds.maxRedeliveries, {
          binding,
          book: stateFor(binding).alarms,
          limit: alarmLimits.get(binding) ?? defaultAlarmsPerObject,
          runAlarm: alarmRunner(
            namespace(binding),
            binding,
            ctx,
            options.durableObjects,
            stateFor(binding),
          ),
          abort: (id) => stateFor(binding).abort(id),
          mayPark: (id) => stateFor(binding).mayPark(id),
          evict: (id) => evictObject(namespace(binding), options.durableObjects, id),
          bookkeep: (op, args) =>
            hooks.effectSync(
              {
                invocation: hooks.bookkeeping(),
                target: `DO:${binding}`,
                op,
                args,
                allowed: [],
              },
              () => null,
              () => null,
            ),
        });
      }
      return drive.kind === "http"
        ? await deliverRequest(event, hooks, spec, drive, invocation, worker)
        : await deliverMessage(event, hooks, spec, drive, invocation, worker, maxRetries);
    },
  };
}
