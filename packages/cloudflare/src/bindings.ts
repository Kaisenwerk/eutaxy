/**
 * Each kind of binding the platform models, as one record: how an env value
 * is recognised, what the Worker sees in its place, what is forgotten before
 * a run, the reset its setup step asks for, the snapshot the run ends with,
 * and, for the kinds with events of their own (alarms, Workflow runs), their
 * delivery. The platform and the differential runner iterate these records;
 * neither knows a kind by name.
 */

import type {
  DeliveryResult,
  EventRef,
  JsonValue,
  PlatformData,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { note } from "@eutaxy/engine";
import { alarmSource, deliverAlarm } from "./alarms.ts";
import { type CalleeModule, CalleeState, calleeEnv, proxyCallee } from "./callees.ts";
import { isD1, proxyD1, resetD1, snapshotD1 } from "./d1.ts";
import {
  BindingState,
  type DurableObjectTestHelpers,
  evictObject,
  forgetHosts,
  proxyNamespace,
  resetNamespace,
  runInObject,
  snapshotNamespace,
} from "./durable-objects.ts";
import {
  deliverWake,
  isDurableObjectNamespace,
  type ObjectAccess,
  wakeEvent,
  wakeSource,
} from "./object-access.ts";
import type { ProxyContext } from "./proxy-context.ts";
import { isR2, proxyR2, resetR2, snapshotR2, VersionBook } from "./r2.ts";
import {
  type CalleeSetup,
  type D1Setup,
  type DurableObjectSetup,
  defaultAlarmsPerObject,
  type R2Setup,
  type ServiceSetup,
  type WorkflowSetup,
} from "./scenario.ts";
import { isServiceBinding, proxyService } from "./services.ts";
import {
  deliverWorkflow,
  isWorkflowBinding,
  proxyWorkflow,
  WorkflowRegistry,
  workflowSource,
} from "./workflows.ts";

/** A setup step that names a binding; every kind modelled here has one. */
export interface BindingSetup extends PlatformData {
  readonly binding: string;
}

/** The tables of one binding's end-of-run snapshot. */
export type Tables = { readonly [table: string]: readonly JsonValue[] };

/**
 * One kind of binding. `Real` is the env value's type once `is` accepted it;
 * `Setup` the setup step that names a binding of this kind.
 */
export interface Binding<Real = unknown, Setup extends BindingSetup = BindingSetup> {
  /** The `kind` of the setup step naming a binding of this type. */
  readonly kind: Setup["kind"];
  /** The prefix of its snapshot targets: `D1`, `DO`, `R2`, `Workflow`. */
  readonly target: string;
  /** Whether an env value is a binding of this kind. */
  is(value: unknown): value is Real;
  /**
   * What the Worker sees in place of the real binding, asked on every access
   * of `env.<name>`: the record keeps one proxy per name where it may, and
   * reports a binding the scenario did not set up each time it is touched.
   * `undefined` means the name is not this record's (two records share one
   * kind of env value: a service binding is a callee's or scripted), so the
   * next record is asked.
   */
  proxy(name: string, real: Real, ctx: ProxyContext): unknown;
  /** Forget what the last run learned, before the next run's setup. */
  clear(): void;
  /** Bring the real binding, or the model, to the state the setup step asks for. */
  reset(step: Setup, real: unknown): Promise<void>;
  /**
   * The snapshot the run ends with, read through the real binding, or null
   * when the env value is not this binding. `unsupported` reports what the
   * snapshot found that the run could not control.
   */
  snapshot(
    step: Setup,
    real: unknown,
    unsupported: (reason: string) => void,
  ): Promise<Tables | null>;
  /** `EventRef.source` of the events this binding emits, when it has any. */
  readonly source?: string;
  /** A second source of events it delivers, when it has one. */
  readonly closingSource?: string;
  /** Deliver one of its events. */
  deliver?(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult>;
  /** Its events the end of the run calls for (see `Platform.closingEvents`), each handed out once. */
  closing?(): readonly EventRef[];
}

/** A D1 database: Miniflare's SQLite, reset to the scenario's schema and read back whole. */
export function d1Binding(schemas: Readonly<Record<string, string>>): Binding<D1Database, D1Setup> {
  const proxies = new Map<string, D1Database>();
  return {
    kind: "d1",
    target: "D1",
    is: isD1,
    proxy(name, real, ctx) {
      let p = proxies.get(name);
      if (!p) {
        p = proxyD1(real, name, ctx);
        proxies.set(name, p);
      }
      return p;
    },
    clear() {},
    async reset(step, real) {
      const schema = schemas[step.binding];
      if (schema === undefined)
        throw new Error(`no schema provided for D1 binding ${step.binding}`);
      if (!isD1(real)) throw new Error(`env.${step.binding} is not a D1 binding`);
      await resetD1(real, schema);
    },
    async snapshot(_step, real) {
      return isD1(real) ? snapshotD1(real) : null;
    },
  };
}

/** An R2 bucket: Miniflare's real one, emptied and seeded before each run. */
export function r2Binding(): Binding<R2Bucket, R2Setup> {
  /** The buckets the current scenario sets up. */
  let setUp = new Set<string>();
  const proxies = new Map<string, R2Bucket>();
  /** One book for every bucket: the stand-ins count up across them. */
  const versions = new VersionBook();
  return {
    kind: "r2",
    target: "R2",
    is: isR2,
    proxy(name, real, ctx) {
      if (!setUp.has(name))
        ctx.hooks.unsupported(
          `R2 binding ${name} needs an r2Bucket() setup step, which empties it before each run`,
        );
      let p = proxies.get(name);
      if (!p) {
        p = proxyR2(real, name, ctx, versions);
        proxies.set(name, p);
      }
      return p;
    },
    clear() {
      setUp = new Set();
      versions.clear();
    },
    async reset(step, real) {
      if (!isR2(real)) throw new Error(`env.${step.binding} is not an R2 bucket`);
      setUp.add(step.binding);
      await resetR2(real, step.objects);
    },
    async snapshot(_step, real) {
      return isR2(real) ? { objects: await snapshotR2(real) } : null;
    },
  };
}

export interface DurableObjectDeps {
  readonly ctx: ProxyContext;
  /** The Cloudflare test helpers, without which objects cannot be reset, seeded or snapshotted. */
  readonly helpers: DurableObjectTestHelpers | undefined;
  /** The env value under a binding name: alarm events name their binding, not an object. */
  readonly real: (name: string) => unknown;
  /** Snapshot every seeded object from its storage: the raw side of a differential, where no proxy saw the calls. */
  readonly snapshotAll?: boolean;
}

/**
 * A Durable Object namespace: the real objects workerd runs, cleared, seeded
 * and evicted before each run, their storage snapshotted after it, and their
 * alarms taken over and fired as events of the run.
 */
export function durableObjectBinding(
  deps: DurableObjectDeps,
): Binding<DurableObjectNamespace, DurableObjectSetup> & { readonly objects: ObjectAccess } {
  const { ctx, helpers } = deps;
  const proxies = new Map<string, DurableObjectNamespace>();
  /** The bindings the current scenario's setup resets before each run. */
  let setUp = new Set<string>();
  /** Per binding, alarm firings allowed per object in the current run. */
  let alarmLimits = new Map<string, number>();
  /** Per binding, what the current run knows about its objects. */
  const states = new Map<string, BindingState>();
  const stateFor = (binding: string): BindingState => {
    let state = states.get(binding);
    if (!state) {
      state = new BindingState();
      states.set(binding, state);
    }
    return state;
  };
  const namespace = (name: string, real: unknown = deps.real(name)): DurableObjectNamespace => {
    if (!isDurableObjectNamespace(real))
      throw new Error(`env.${name} is not a Durable Object namespace`);
    return real;
  };
  const required = (): DurableObjectTestHelpers => {
    if (!helpers)
      throw new Error(
        'Durable Object setup needs the Cloudflare test helpers: createCloudflarePlatform({ ..., durableObjects: await import("cloudflare:test") })',
      );
    return helpers;
  };
  const objects: ObjectAccess = {
    run: (binding, id, object, fn) =>
      runInObject(namespace(binding), binding, ctx, helpers, stateFor(binding), id, object, fn),
    abort: (binding, id) => stateFor(binding).abort(id),
    mayPark: (binding, id) => stateFor(binding).mayPark(id),
    evict: (binding, id) => {
      // The instance a crash left is dropped: woken at the end of the run unless something enters it.
      stateFor(binding).dropped.add(id);
      return evictObject(namespace(binding), helpers, id);
    },
  };
  /** Wakes handed out this run, to name each one. */
  let wakes = 0;
  /** Wakes delivered to each object this run, by binding and id. */
  const woken = new Map<string, number>();
  return {
    objects,
    kind: "durable_object",
    target: "DO",
    is: isDurableObjectNamespace,
    proxy(name, real, ctx) {
      let p = proxies.get(name);
      if (!p) {
        p = proxyNamespace(real, name, ctx, stateFor(name), helpers, () => setUp.has(name));
        proxies.set(name, p);
      }
      return p;
    },
    clear() {
      setUp = new Set();
      alarmLimits = new Map();
      wakes = 0;
      woken.clear();
      forgetHosts();
      for (const state of states.values()) state.clear();
    },
    async reset(step, real) {
      setUp.add(step.binding);
      alarmLimits.set(step.binding, step.alarmsPerObject ?? defaultAlarmsPerObject);
      stateFor(step.binding).seededSql = await resetNamespace(
        namespace(step.binding, real),
        required(),
        stateFor(step.binding).names,
        step.objects,
        step.sql ?? {},
      );
    },
    async snapshot(step, real, unsupported) {
      const binding = step.binding;
      return snapshotNamespace(
        namespace(binding, real),
        required(),
        stateFor(binding).names,
        stateFor(binding).touched,
        step.objects,
        step.sql ?? {},
        stateFor(binding).seededSql,
        (object) =>
          unsupported(
            `Durable Object ${binding} ${object} was reached without a call Eutaxy saw (through another object's binding); calls between objects are not proxied yet`,
          ),
        unsupported,
        deps.snapshotAll === true,
      );
    },
    source: alarmSource,
    closingSource: wakeSource,
    closing() {
      const events: EventRef[] = [];
      for (const [binding, state] of states) {
        for (const id of [...state.dropped].sort()) {
          state.dropped.delete(id);
          events.push(wakeEvent(binding, id, state.names.get(id) ?? id, ++wakes));
        }
      }
      return events;
    },
    async deliver(event, hooks, spec) {
      if (event.source === wakeSource) {
        const { binding, id, object } = event.data as {
          binding: string;
          id: string;
          object: string;
        };
        const key = `${binding}\n${id}`;
        const times = (woken.get(key) ?? 0) + 1;
        woken.set(key, times);
        const result = await deliverWake(event, hooks, objects);
        // A wake that left the object dropped again failed: a fault landed in its constructor, or
        // the constructor fails by itself. Each fault explains one failure, so more failures than
        // the run has faults are the object's own, and waking it again would fail the same way.
        const state = stateFor(binding);
        if (state.dropped.has(id) && times > spec.bounds.maxFaultsPerRun) {
          state.dropped.delete(id);
          hooks.unsupported(
            `Durable Object ${binding} ${object} could not be woken at the end of the run: a callback behind its input gate failed each of the ${times} times it was constructed for that, more often than the run's faults explain, so what its storage holds was not read as its next event would find it`,
          );
        }
        return result;
      }
      const binding = String((event.data as { binding?: unknown }).binding ?? "");
      return deliverAlarm(event, hooks, spec.bounds.maxRedeliveries, {
        binding,
        book: stateFor(binding).alarms,
        limit: alarmLimits.get(binding) ?? defaultAlarmsPerObject,
        objects,
        bookkeep: (op, args) =>
          note(hooks, {
            invocation: hooks.bookkeeping(),
            target: `DO:${binding}`,
            op,
            args,
            allowed: [],
          }),
      });
    },
  };
}

export interface WorkflowDeps {
  /** The Worker module's exports, where the classes `workflow` setup steps name are found. */
  readonly exports: Readonly<Record<string, unknown>> | undefined;
  /** The env the instances run with: the Worker's proxied one. */
  readonly env: () => object;
  /** The callee a qualified binding (`inventory/FLOW`) belongs to, if the platform was given it: its classes and env are the callee's. */
  readonly calleeOf?: (binding: string) => CalleeModule | undefined;
}

/**
 * A Workflow binding: a model of the engine running the scenario's own
 * class, never the real binding; instances live in a registry and run as
 * events of the run.
 */
export function workflowBinding(deps: WorkflowDeps): Binding<object, WorkflowSetup> {
  /** The bindings the current scenario sets up, with the class each runs. */
  let classes = new Map<string, WorkflowSetup>();
  const registries = new Map<string, WorkflowRegistry>();
  const registryFor = (binding: string): WorkflowRegistry => {
    let r = registries.get(binding);
    if (!r) {
      r = new WorkflowRegistry();
      registries.set(binding, r);
    }
    return r;
  };
  const proxies = new Map<string, object>();
  return {
    kind: "workflow",
    target: "Workflow",
    is: isWorkflowBinding,
    proxy(name, _real, ctx) {
      if (!classes.has(name)) {
        ctx.hooks.unsupported(
          `Workflow binding ${name} needs a workflow() setup step naming its class`,
        );
        // Never the real binding: its engine would run the class on the real clock.
        return proxyWorkflow(name, ctx, new WorkflowRegistry());
      }
      let p = proxies.get(name);
      if (!p) {
        p = proxyWorkflow(name, ctx, registryFor(name));
        proxies.set(name, p);
      }
      return p;
    },
    clear() {
      classes = new Map();
      for (const registry of registries.values()) registry.clear();
    },
    async reset(step) {
      classes.set(step.binding, step);
    },
    async snapshot(step) {
      return { instances: registryFor(step.binding).rows() };
    },
    source: workflowSource,
    async deliver(event, hooks, spec) {
      const { binding, id } = event.data as { binding: string; id: string };
      const setup = classes.get(binding);
      // A binding with no setup step was already reported when the Worker touched it.
      if (!setup) return { status: "errored", followUps: [] };
      const className = setup.className;
      // A callee's Workflow runs the callee's class with the callee's env, as the callee's code does.
      const callee = deps.calleeOf?.(binding);
      const cls = (callee?.exports ?? deps.exports)?.[className];
      const instance = registryFor(binding).instances.get(id);
      if (typeof cls !== "function" || !instance) {
        hooks.unsupported(
          callee
            ? `Workflow ${binding}: class ${className} is not among the exports of the callee ${callee.name}`
            : `Workflow ${binding}: class ${className} is not among the Worker module's exports; pass them as createCloudflarePlatform({ ..., exports })`,
        );
        return { status: "errored", followUps: [] };
      }
      return deliverWorkflow(event, hooks, {
        binding,
        ...(setup.name === undefined ? {} : { name: setup.name }),
        instance,
        cls,
        env: callee ? calleeEnv(callee.name, deps.env()) : deps.env(),
        maxFaultsPerRun: spec.bounds.maxFaultsPerRun,
        maxRedeliveries: spec.bounds.maxRedeliveries,
      });
    },
  };
}

export interface CalleeDeps {
  /** The callees' modules by binding, as the test gives them. */
  readonly callees: Readonly<Record<string, CalleeModule>> | undefined;
  /** The scenario's env as the Worker sees it: the callee's env is a view of it under qualified names. */
  readonly env: () => object;
}

/**
 * A service binding whose callee runs for real (a `callee` setup step): a
 * stub running the callee's module inside each call. Never the real binding.
 * Nothing to reset or snapshot of its own: the callee's bindings have their
 * own steps under their qualified names. A binding without a `callee` step
 * is not this record's.
 */
export function calleeBinding(deps: CalleeDeps): Binding<object, CalleeSetup> {
  /** The bindings the current scenario names a callee for. */
  let setups = new Map<string, CalleeSetup>();
  const proxies = new Map<string, object>();
  const state = new CalleeState();
  return {
    kind: "callee",
    target: "Service",
    is: isServiceBinding,
    proxy(name, _real, ctx) {
      const setup = setups.get(name);
      if (!setup) return undefined;
      let p = proxies.get(name);
      if (!p) {
        const module = deps.callees?.[name];
        if (!module) {
          ctx.hooks.unsupported(
            `callee ${name}: the platform was not given its module; pass createCloudflarePlatform({ ..., callees: { ${name}: { name, exports } } }), as eutaxy check does from the callee() step`,
          );
          // Never the real binding: a stub whose every call is reported.
          return proxyService(name, ctx, { kind: "service", binding: name, methods: {} });
        }
        p = proxyCallee(name, ctx, setup, module, deps.env(), state);
        proxies.set(name, p);
      }
      return p;
    },
    clear() {
      setups = new Map();
      proxies.clear();
      state.clear();
    },
    async reset(step) {
      setups.set(step.binding, step);
    },
    async snapshot() {
      return null;
    },
  };
}

/**
 * A service binding: never the real binding, a stub answering from the
 * scenario's `service` setup; each call one effect. Nothing to reset or
 * snapshot, the callee is scripted.
 */
export function serviceBinding(): Binding<object, ServiceSetup> {
  /** The bindings the current scenario scripts. */
  let scripts = new Map<string, ServiceSetup>();
  /** Per binding, the stub for the current run's script. */
  const proxies = new Map<string, object>();
  return {
    kind: "service",
    target: "Service",
    is: isServiceBinding,
    proxy(name, _real, ctx) {
      const script = scripts.get(name);
      if (!script) {
        ctx.hooks.unsupported(
          `service binding ${name} needs a service() setup step scripting the Worker it reaches`,
        );
        // Never the real binding: it would call the real peer.
        return proxyService(name, ctx, { kind: "service", binding: name, methods: {} });
      }
      let p = proxies.get(name);
      if (!p) {
        p = proxyService(name, ctx, script);
        proxies.set(name, p);
      }
      return p;
    },
    clear() {
      scripts = new Map();
      proxies.clear();
    },
    async reset(step) {
      scripts.set(step.binding, step);
    },
    async snapshot() {
      return null;
    },
  };
}

/**
 * The setup steps these records own, each with its record, in setup order:
 * what the platform resets and snapshots, and the differential runner
 * compares. A step no record owns is left to the scenario's validation.
 */
export function ownedSetups(
  setup: ScenarioSpec["setup"],
  bindings: readonly Binding[],
): readonly (readonly [Binding, BindingSetup])[] {
  const out: (readonly [Binding, BindingSetup])[] = [];
  // Several d1Schema steps on one binding are migrations of one database, whose schema is their files
  // joined: it is reset and snapshotted once, at its first step.
  const databases = new Set<string>();
  for (const step of setup) {
    const binding = bindings.find((b) => b.kind === step.kind);
    if (!binding) continue;
    if (step.kind === "d1") {
      const name = String(step["binding"]);
      if (databases.has(name)) continue;
      databases.add(name);
    }
    out.push([binding, step as BindingSetup]);
  }
  return out;
}
