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
  type Platform,
  type RunHooks,
  type ScenarioSpec,
} from "@eutaxy/core";
import { withoutNetwork } from "@eutaxy/engine";
import type { RunningWorker } from "./background.ts";
import {
  type Binding,
  calleeBinding,
  d1Binding,
  durableObjectBinding,
  ownedSetups,
  r2Binding,
  serviceBinding,
  workflowBinding,
} from "./bindings.ts";
import type { CalleeModule } from "./callees.ts";
import {
  type DurableObjectTestHelpers,
  scriptsOutsideRuns,
  simulateConstruction,
  simulatingConstruction,
} from "./durable-objects.ts";
import { entrypointHandler } from "./entrypoint.ts";
import { deliverRequest } from "./http.ts";
import { type ProxyContext, refuse } from "./proxy-context.ts";
import { deliverMessage } from "./queues.ts";
import { deliverCall, entrypointClass } from "./rpc.ts";
import { type Drive, driveEvents, restrictDrive, type ServiceSetup } from "./scenario.ts";
import { deliverTick } from "./scheduled.ts";
import { Connections, deliverWebSocket } from "./websocket.ts";

/** The Worker's default export, as far as the platform drives it. */
export interface WorkerHandler {
  queue?(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): void | Promise<void>;
  fetch?(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(
    controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext,
  ): void | Promise<void>;
}

/** A `WorkerEntrypoint` subclass: the Worker's default export when it exposes RPC methods. Its env is its own. */
export type WorkerEntrypointClass = abstract new (ctx: ExecutionContext, env: never) => object;

/**
 * What `createCloudflarePlatform` needs: the env and the Worker's default export, the schema per D1
 * binding, and for the bindings that need them the test helpers, the module's exports, the callees and
 * the aliases.
 */
export interface CloudflarePlatformOptions {
  /** The bindings from `cloudflare:workers`. */
  readonly env: object;
  /**
   * The Worker's default export: the handler object, or a
   * `WorkerEntrypoint` class, whose `fetch()`, `queue()` and `scheduled()`
   * are its handlers and whose other methods the `rpc` drive calls.
   */
  readonly handler: WorkerHandler | WorkerEntrypointClass;
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
  /**
   * The Workers behind service bindings that `callee` setup steps name, by
   * binding: each one's name from its wrangler config, which qualifies its
   * bindings in `env` (`orders/DB`), and its module's exports.
   */
  readonly callees?: Readonly<Record<string, CalleeModule>>;
  /**
   * Bindings that name a resource another binding already names (the same
   * database, the same Durable Object namespace), by their qualified name
   * (`inventory/DB`) to the name the resource is set up and snapshotted
   * under (`DB`): one resource, one snapshot, the alias a second name for it
   * in `env`. A setup step on an alias is refused.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}

/**
 * Whether an env value is a binding and not a var: something with methods.
 * A JSON var is plain data, whose only methods are `Object.prototype`'s or
 * an array's, so those do not count; a test double written as an object
 * literal counts by the functions it holds itself.
 */
function isBindingLike(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  const inherited = proto === null || proto === Object.prototype ? {} : proto;
  const names = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertyNames(inherited)];
  return names.some(
    (k) => k !== "constructor" && typeof (value as Record<string, unknown>)[k] === "function",
  );
}

const assumptions: readonly string[] = [
  "platform model: Cloudflare Queues at-least-once delivery; the first ack or retry decision per message wins; unacked messages are redelivered up to max_retries then dead-lettered",
  "D1 statements run against Miniflare's SQLite; each run/first/all/raw/batch/exec is one effect; SQL that reads the time or draws randomness itself (CURRENT_TIMESTAMP, strftime('now'), random()) reads SQLite's own clock and generator, not the virtual ones, so a value it stores differs from run to run",
  "message.timestamp is the virtual clock's time at delivery",
  "only D1, Durable Object, R2, Workflow and scripted service bindings are proxied; a call on any other binding makes the run UNSUPPORTED (reading one off env does not)",
  "service bindings are scripted callees unless the scenario names a callee for them: the Worker behind a scripted binding is never called; each RPC method call or fetch() through it is one effect answered from the scenario's service() setup, where crash_before and error mean the call never reached the callee, ambiguous that it acted and the answer was lost, and crash_after that the caller died after it (developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/); Cloudflare does not retry such a call",
  "a callee that is the scenario's own Worker, called back by a Worker it called, runs with the scenario's env under its own names; a binding named as an alias of another (the same database, the same Durable Object namespace, in two Workers' configs) is that binding: its effects and snapshot carry the other's name, and a callee's Workflow runs the callee's class with the callee's env",
  "a service binding with a callee() setup runs that Worker's real code in the caller's simulation, in the same isolate, as Cloudflare runs both Workers on one thread (developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/): each RPC method call or fetch() through it is one effect hosting the callee's invocation (<caller invocation>/<binding>.<method>), which constructs the entrypoint anew with a fresh ExecutionContext and the callee's env (its bindings under <worker name>/<binding>) and answers with the return value, plain data by copy, or the Response as it is; what the callee throws reaches the caller as a new error with its name, message and serializable own properties, a built-in class as itself (developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/); the callee's waitUntil work finishes before its answer crosses; crash_before means the call never reached the callee, ambiguous that it acted and the answer was lost, crash_after that the caller died after it, and a fault that crashes the callee ends its invocation and throws an Error to the caller; Cloudflare retries nothing",
  "R2 buckets are Miniflare's real ones, emptied and seeded before each run and snapshotted after it; R2 is strongly consistent and the last writer wins (developers.cloudflare.com/r2/reference/consistency/); each put, delete, get, head and list is one effect, a body is read inside its get, and an object's version and upload time are stand-ins so traces repeat; multipart uploads and conditions on the upload time are not modelled",
  "Durable Objects are the real objects workerd runs (storage, transactions, input and output gates are the runtime's own); each stub call is one effect: crash_before or error means it never reached the object, ambiguous means the object committed and the caller lost the answer, crash_after means the caller died after it; in a concurrent run an object's own outbound I/O during a call is a turn, so another event may enter the object meanwhile (its input gate is open then), except while it holds the gate with blockConcurrencyWhile, when its effects run at once; work an object starts and does not await (a promise left running, a timer, ctx.waitUntil) goes on after its answer as the object's own invocation, DO:<binding>/<object>/after, whose effects are turns of their own and take faults by their position in it, until nothing of it can move or a crash resets the object, which ends it with the instance (work that keeps setting timers is waited for up to 100 firings without settling, then the run is UNSUPPORTED); an object that awaits a timer of its own before answering is woken by it; an effect it issued before its answer and did not await, a timer it set and real work it started (Web Crypto) are its own once the call has answered: the caller's crash does not end them and a fault in them resets the object, not the caller; in a sequential run that work runs to rest before the next event (developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/); storage operations are not turns (the input gate holds other events during them); a call the object makes through a service binding on this.env is the scenario's: an effect of the invocation its code runs as (the call it serves, or its own work after the answer), answered from the service() script or by the callee() hosted inside it, and leaving the object once its earlier writes are durable, as behind the output gate (developers.cloudflare.com/durable-objects/api/state/, /durable-objects/concepts/durable-object-lifecycle/); its calls on its other bindings (D1, R2) are not recorded; a callback behind blockConcurrencyWhile that fails resets the object, as the runtime does (developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile); objects are cleared, seeded and evicted before each run and their storage is snapshotted after it, an object a crash reset and nothing entered since being woken once inside the run first (a wake effect, its constructor's effects hosted), as its next event would wake it (developers.cloudflare.com/durable-objects/api/storage-api/)",
  "Durable Object alarms are taken over so none is scheduled on the real clock and fire in virtual time: one alarm per object, a later setAlarm replaces it, setAlarm in a transaction applies on commit, the alarm survives eviction, alarm() is one effect (crash_before: it never ran; crash_after: it ran and counts as failed; error: it threw), and a failed alarm is retried after 2 s, 4 s, 8 s ... up to six retries and maxRedeliveries, with retryCount and isRetry (developers.cloudflare.com/durable-objects/api/base/#alarm); each object's alarm fires at most alarmsPerObject times per run (default 3)",
  "Workflows are a model of the engine, never the local one, running the scenario's own class: create is one effect that queues the instance; each step.do attempt is two effect points around its callback, which runs as the instance's own code (step, crash_before: the engine restarts before it; step_result, crash_after: it ran and committed but its result was not persisted, so it runs again; ambiguous at step: the attempt outlives its timeout from its start; ambiguous at step_result: it ran but counted as failed just after its work, as a timeout does); a failed attempt is retried after its delay in virtual time (defaults 5 retries, 10 s, exponential, merged field by field with a step's config), up to its limit and maxRedeliveries, except a NonRetryableError; a restart re-runs run() from the start with the persisted step and sleep results, so code outside steps repeats; a step's timeout is measured in virtual time (default 10 minutes), and an attempt that passes it is not stopped, as the engine cannot stop it either: it runs on as the late attempt while the step is retried or fails for good, its result dropped, and in a concurrent run its remaining effects land before, between or after the retry's or the recovery's (a sequential run lets it run first) (developers.cloudflare.com/workflows/build/rules-of-workflows/, /workflows/build/sleeping-and-retrying/)",
  "state invariants read a snapshot of every D1 binding named in setup, taken after the last event",
  "work passed to ctx.waitUntil runs after the handler returns and never affects acknowledgement or the response; a cut_off fault at that point loses work not yet started, and an effect in flight commits without its continuation",
  "concurrent invocations (maxConcurrentInvocations above 1) share one isolate's module state and bindings, and another may run while one awaits I/O (developers.cloudflare.com/workers/reference/how-workers-works/); queue consumers run concurrently up to max_concurrency (developers.cloudflare.com/queues/configuration/consumer-concurrency/)",
  "inbound requests: one invocation per attempt; an uncaught exception is a 500 response; the drive's caller resends a request it got no acceptable response for (crash before the response, an answer after its deadlineMs, or a status its retryOn policy rejects) up to its retries, each resend after its delaysMs entry of virtual time; the handler's own time is virtual, so a late answer is the ambiguous fault at the response point or an answer later than deadlineMs in virtual time",
  "cron triggers: each tick of the drive's expression is one invocation of scheduled(), with scheduledTime the tick's virtual time (UTC, the expression's matches from the virtual epoch on, in Cloudflare's dialect where weekdays run 1 = Sunday to 7 = Saturday; L, W and # are not modelled) and cron the expression (developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/, /workers/configuration/cron-triggers/); Cloudflare documents noRetry() but no retry count, so the drive declares how many times a tick whose handler failed is re-run, and none after noRetry()",
  "inbound RPC: one invocation per call attempt, the entrypoint constructed anew for each with a fresh ExecutionContext (developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/); the return value is the response effect, and an exception reaches the caller as a new error with its name and message (developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/); Cloudflare does not retry a call, so the drive's caller resends a call that threw or got no answer as the http drive's caller does; a result that is not plain data (a stub, a function, a stream) makes the run UNSUPPORTED",
];

/**
 * The Cloudflare platform for `check`, run inside workerd under the Cloudflare Vitest plugin: the scenario's
 * drive delivered to the Worker's handlers, its bindings proxied so every call is an effect that faults can
 * hit, and the setup's resources reset before each run and snapshotted after it.
 */
export function createCloudflarePlatform(options: CloudflarePlatformOptions): Platform {
  const env = options.env as Record<string, unknown>;
  const aliases = options.aliases ?? {};
  /** The name a binding is known by: itself, or the name it is an alias of. */
  const canonical = (name: string): string => aliases[name] ?? name;
  const maxRetries = options.maxRetries ?? 3;
  let hooksRef: RunHooks | null = null;

  const connections = new Connections();
  const ctx: ProxyContext = {
    get hooks() {
      if (!hooksRef) throw new Error("no run in progress");
      return hooksRef;
    },
    // Bindings are shared by every invocation in flight; the engine knows which one is running.
    currentInvocation: () => ctx.hooks.running(),
    env: () => proxiedEnv,
    gate: { pending: undefined },
    onUpgrade: (info) => connections.upgradedTo(info),
  };

  /**
   * The kinds of binding modelled, in the order an env value is tried against
   * them: service bindings first (a callee's, then scripted), since in workerd
   * they answer every duck type (their property reads are RPC stubs).
   */
  // The Worker's and the callees' Durable Object classes are constructed with the scenario's env.
  simulateConstruction(options.exports);
  for (const callee of Object.values(options.callees ?? {})) simulateConstruction(callee.exports);
  const durable = durableObjectBinding({
    ctx,
    helpers: options.durableObjects,
    real: (name) => env[name],
  });
  const bindings: readonly Binding[] = [
    calleeBinding({ callees: options.callees, env: () => proxiedEnv }),
    serviceBinding(),
    d1Binding(options.schemas),
    durable,
    r2Binding(),
    workflowBinding({
      exports: options.exports,
      env: () => proxiedEnv,
      // A qualified binding's callee: the Worker whose name qualifies it.
      calleeOf: (binding) => {
        const at = binding.indexOf("/");
        if (at < 0) return undefined;
        const name = binding.slice(0, at);
        return Object.values(options.callees ?? {}).find((c) => c.name === name);
      },
    }),
  ];
  // The Cloudflare Vitest plugin adds bindings of its own to env (its loopback and self services, its
  // runner object); a Worker that walks env (the Agents SDK's router does, to name each namespace) must
  // not meet them: they are the test environment's, not the Worker's.
  const own = (prop: string | symbol): boolean =>
    typeof prop !== "string" || !prop.startsWith("__VITEST_POOL_WORKERS_");
  // An alias is read as the binding it names, so effects and snapshots carry that binding's name.
  const aliasKeys = Object.keys(aliases).filter((a) => canonical(a) in env);
  /**
   * What the Worker sees under a binding of a kind the simulation does not
   * model: the binding with every method refused. Reading it does nothing,
   * as code that builds its dependencies from `env` on every call does;
   * the first call on it ends the run `UNSUPPORTED` and is never passed to
   * the real binding.
   */
  const standIns = new Map<string, object>();
  const unproxied = (name: string, real: object): object => {
    let p = standIns.get(name);
    if (!p) {
      const refuseCall = (): never => refuse(ctx, `binding ${name} is not proxied`);
      p = new Proxy(typeof real === "function" ? refuseCall : {}, {
        get(_t, prop) {
          const value = Reflect.get(real, prop, real) as unknown;
          return typeof value === "function" ? refuseCall : value;
        },
        has: (_t, prop) => Reflect.has(real, prop),
        // Its keys and data are the binding's own, for code that walks or copies what it was given.
        ownKeys: () => Reflect.ownKeys(real),
        getOwnPropertyDescriptor(_t, prop) {
          const d = Reflect.getOwnPropertyDescriptor(real, prop);
          if (!d) return undefined;
          const value = Reflect.get(real, prop, real) as unknown;
          return {
            value: typeof value === "function" ? refuseCall : value,
            enumerable: d.enumerable ?? false,
            configurable: true,
            writable: false,
          };
        },
        apply: refuseCall,
      });
      standIns.set(name, p);
    }
    return p;
  };
  const proxiedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      if (!own(prop)) return undefined;
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver) as unknown;
      const name = canonical(prop);
      const value = Reflect.get(target, name, receiver) as unknown;
      for (const binding of bindings) {
        if (!binding.is(value)) continue;
        const proxied = binding.proxy(name, value, ctx);
        if (proxied !== undefined) return proxied;
      }
      return isBindingLike(value) ? unproxied(name, value as object) : value;
    },
    has: (target, prop) =>
      own(prop) &&
      (Reflect.has(target, prop) || (typeof prop === "string" && aliasKeys.includes(prop))),
    // An alias may also be a key of env (the test declared it for the callee's sake): listed once.
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target).filter(own), ...aliasKeys])],
    getOwnPropertyDescriptor: (target, prop) => {
      if (!own(prop)) return undefined;
      if (typeof prop === "string" && aliasKeys.includes(prop))
        return {
          value: env[canonical(prop)],
          enumerable: true,
          configurable: true,
          writable: false,
        };
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  // An entrypoint class exposes RPC methods, and its fetch(), queue() and scheduled() are the Worker's
  // handlers, called on an instance constructed for each invocation.
  const handler: WorkerHandler =
    typeof options.handler === "function"
      ? (entrypointHandler(options.handler) as WorkerHandler)
      : options.handler;
  const worker: RunningWorker = { handler, env: proxiedEnv };

  return {
    name: "cloudflare",
    assumptions,
    concurrent: true,

    async reset(spec: ScenarioSpec): Promise<void> {
      await connections.clear();
      for (const binding of bindings) binding.clear();
      // From here to the cleanup, a Durable Object is constructed with the scenario's env.
      simulatingConstruction(true);
      // What a constructor calls while its object is reset is answered from the scenario's scripts.
      scriptsOutsideRuns((name) =>
        spec.setup.find((s): s is ServiceSetup => s.kind === "service" && s["binding"] === name),
      );
      for (const [binding, setup] of ownedSetups(spec.setup, bindings)) {
        // One resource is set up once, under the name it is known by.
        if (setup.binding in aliases)
          throw new Error(
            `binding ${setup.binding} is an alias of ${canonical(setup.binding)}: set it up and read it as ${canonical(setup.binding)}`,
          );
        await binding.reset(setup, env[setup.binding]);
      }
    },

    async cleanup(): Promise<void> {
      // Outside the platform's runs a class is constructed with the runtime's env again.
      simulatingConstruction(false);
    },

    restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec {
      return { ...spec, drive: restrictDrive(spec.drive as Drive, keepIds) };
    },

    async finish(spec: ScenarioSpec, hooks: RunHooks): Promise<void> {
      // What each WebSocket connection received, and a close its object made, before the stores are read.
      connections.record(hooks);
      for (const [binding, setup] of ownedSetups(spec.setup, bindings)) {
        const tables = await binding.snapshot(setup, env[setup.binding], (reason) =>
          hooks.unsupported(reason),
        );
        if (tables)
          hooks.snapshot(hooks.bookkeeping(), `${binding.target}:${setup.binding}`, { tables });
      }
      // Then the connections are torn down, outside the run: what an object does on close is not
      // modelled, and a request it makes then is caught.
      const torn = await withoutNetwork(() => connections.teardown(durable.objects));
      if (torn.value) hooks.unsupported(torn.value);
      if (torn.requested)
        hooks.unsupported(
          "a Durable Object made a request while its WebSocket connections were torn down after the run; what webSocketClose does is not modelled",
        );
    },

    closingEvents(): readonly EventRef[] {
      return bindings.flatMap((b) => b.closing?.() ?? []);
    },

    initialEvents(spec: ScenarioSpec): readonly EventRef[] {
      return driveEvents(spec.drive as Drive);
    },

    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const drive = spec.drive as Drive;
      const invocation = invocationOf(event);
      hooksRef = hooks;
      // An event of a binding's own (an alarm, a Workflow run) is the binding's to deliver.
      const owner =
        event.source === undefined
          ? undefined
          : bindings.find((b) => b.source === event.source || b.closingSource === event.source);
      if (owner?.deliver) return owner.deliver(event, hooks, spec);
      switch (drive.kind) {
        case "http":
          return deliverRequest(event, hooks, spec, drive, invocation, worker);
        case "cron":
          return deliverTick(event, hooks, spec, drive, invocation, worker);
        case "websocket":
          return deliverWebSocket(event, hooks, spec, drive, {
            worker,
            connections,
            objects: durable.objects,
          });
        case "rpc": {
          const cls = entrypointClass(options.handler, options.exports, drive.entrypoint);
          if (typeof cls !== "function") {
            hooks.unsupported(
              `Rpc: ${drive.entrypoint === undefined ? "the Worker's default export" : `export ${drive.entrypoint}`} is not a WorkerEntrypoint class; pass the Worker module's exports as createCloudflarePlatform({ ..., exports })`,
            );
            return { status: "errored", followUps: [] };
          }
          return deliverCall(event, hooks, spec, drive, invocation, cls, proxiedEnv);
        }
        default:
          return deliverMessage(event, hooks, spec, drive, invocation, worker, maxRetries);
      }
    },
  };
}
