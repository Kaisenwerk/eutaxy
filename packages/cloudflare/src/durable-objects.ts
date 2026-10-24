/**
 * The Durable Object namespace proxy. The objects are the real ones workerd
 * runs: storage, transactions and the input and output gates are the
 * runtime's own. Eutaxy proxies the boundary a Worker crosses to reach them:
 * every call on a stub is an effect point, so a call can fail before it
 * reaches the object (`crash_before`, `error`), or reach it, commit, and
 * lose its answer (`ambiguous`) or its caller (`crash_after`).
 *
 * Between runs every object is cleared, seeded from the scenario's setup
 * and evicted, so it starts from storage alone; after a run its storage is
 * snapshotted for state invariants. Both go through the Cloudflare Vitest
 * plugin's test helpers. Alarms are taken over on each object's storage and
 * fire in virtual time (see alarms.ts).
 */

import { type FaultKind, type JsonValue, toJson } from "@eutaxy/core";
import { withoutNetwork } from "@eutaxy/engine";
import { AlarmBook, alarmControl, takenOver, takeOverAlarms } from "./alarms.ts";
import type { ProxyContext } from "./d1.ts";

const CALL: readonly FaultKind[] = ["crash_before", "crash_after", "ambiguous", "error"];

/**
 * The Cloudflare Vitest plugin's test helpers, as exported by
 * `cloudflare:test` (pass the module namespace). Typed loosely on purpose:
 * the plugin's generic overloads are too deep to check against an interface.
 */
export interface DurableObjectTestHelpers {
  readonly runInDurableObject: unknown;
  readonly evictDurableObject: unknown;
  readonly listDurableObjectIds: unknown;
}

/** The helpers with the signatures this module calls them with. */
interface Helpers {
  runInDurableObject<R>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
  evictDurableObject(stub: DurableObjectStub): Promise<void>;
  listDurableObjectIds(namespace: DurableObjectNamespace): Promise<DurableObjectId[]>;
}

const typed = (helpers: DurableObjectTestHelpers): Helpers => helpers as unknown as Helpers;

export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

/** Object names by id, so snapshots and the log name objects as the Worker does. */
export type ObjectNames = Map<string, string>;

/** How deep each object state is inside blockConcurrencyWhile, while it is. */
const gateDepth = new WeakMap<object, number>();
/** Object-state prototypes whose blockConcurrencyWhile records that depth. */
const gateWatched = new WeakSet<object>();

/**
 * Record when an object holds its input gate with blockConcurrencyWhile,
 * on the state prototype so constructors are covered too; the wrapper only
 * records and calls the native method.
 */
function watchGate(state: DurableObjectState): void {
  const proto = Object.getPrototypeOf(state) as {
    blockConcurrencyWhile?: (cb: () => Promise<unknown>) => Promise<unknown>;
  };
  if (!proto || gateWatched.has(proto) || typeof proto.blockConcurrencyWhile !== "function") return;
  gateWatched.add(proto);
  const native = proto.blockConcurrencyWhile;
  proto.blockConcurrencyWhile = function (this: object, callback: () => Promise<unknown>) {
    return native.call(this, async () => {
      gateDepth.set(this, (gateDepth.get(this) ?? 0) + 1);
      try {
        return await callback();
      } finally {
        gateDepth.set(this, (gateDepth.get(this) ?? 1) - 1);
      }
    });
  };
}

/** Whether the object is inside blockConcurrencyWhile now. */
function gateHeld(state: DurableObjectState | undefined): boolean {
  return state !== undefined && (gateDepth.get(state) ?? 0) > 0;
}

/** What Eutaxy keeps about one namespace during a run; the platform clears it before each run. */
export class BindingState {
  /** Names learned this run (seeded ones come back with the setup), so traces never depend on earlier runs. */
  readonly names: ObjectNames = new Map();
  /** Ids of the objects a call or an alarm reached this run. */
  readonly touched = new Set<string>();
  /** The objects' alarms in virtual time. */
  readonly alarms = new AlarmBook();
  /** Each reached object's live state, so an invocation that crashes inside it can reset it. */
  readonly states = new Map<string, DurableObjectState>();

  /** Whether the object's own effects may wait for a turn: not while it holds its input gate. */
  mayPark(id: string): boolean {
    return !gateHeld(this.states.get(id));
  }

  clear(): void {
    this.names.clear();
    this.touched.clear();
    this.alarms.clear();
    this.states.clear();
  }

  /**
   * Reset an object the way a crash does, with `ctx.abort()`, which
   * application code cannot catch: the runtime ends the requests inside it.
   * Called where an injected crash happens inside the object's own work,
   * which is the one place abort() works (from outside, workerd refuses).
   */
  abort(id: string): void {
    const state = this.states.get(id);
    this.states.delete(id);
    try {
      state?.abort("Eutaxy: the invocation crashed inside this object");
    } catch {
      // abort() throws to unwind the object's code; the reset has happened.
    }
  }
}

/** The storage's own alarm deletion, even after Eutaxy replaced the method on it. */
async function deleteRealAlarm(storage: DurableObjectStorage): Promise<void> {
  const proto = Object.getPrototypeOf(storage) as { deleteAlarm?: () => Promise<void> };
  const own = Object.hasOwn(storage, "deleteAlarm");
  const deleteAlarm = own ? proto.deleteAlarm : storage.deleteAlarm;
  await deleteAlarm?.call(storage);
}

/** An RPC argument as effect-log data; a Request becomes its method and URL. */
function argument(value: unknown): JsonValue {
  if (value instanceof Request) return { method: value.method, url: value.url };
  return toJson(value);
}

/**
 * Whether a result is data the caller holds by value. Anything else (an RPC
 * capability, an object with methods) would let later calls bypass the
 * proxy, so it makes the run UNSUPPORTED.
 */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "function") return false;
  if (typeof value !== "object") return true;
  // Too deep to inspect: not certified as data.
  if (depth > 8) return false;
  if (value instanceof Response || value instanceof Date) return true;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return value.every((v) => isPlainData(v, depth + 1));
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => isPlainData(v, depth + 1));
}

/** An RPC result as effect-log data; a Response becomes its status. */
function summarize(result: unknown): JsonValue {
  if (result instanceof Response) return { status: result.status, ok: result.ok };
  return toJson(result);
}

export function proxyNamespace(
  real: DurableObjectNamespace,
  binding: string,
  ctx: ProxyContext,
  state: BindingState,
  helpers: DurableObjectTestHelpers | undefined,
  /** Whether the running scenario resets this namespace (has a `durableObject` setup for it). */
  isReset: () => boolean,
): DurableObjectNamespace {
  const target = `DO:${binding}`;
  const { names, touched, alarms: book } = state;
  const nameOf = (id: DurableObjectId) => names.get(id.toString()) ?? id.toString();

  function stubFor(stub: DurableObjectStub, id: string, object: string): DurableObjectStub {
    /** Make sure the call may reach the object, and take over its alarms first. */
    async function reach(real: DurableObjectStub): Promise<void> {
      if (!helpers) {
        ctx.hooks.unsupported(
          `Durable Object binding ${binding} needs the Cloudflare test helpers (pass durableObjects to createCloudflarePlatform)`,
        );
      } else if (!isReset()) {
        ctx.hooks.unsupported(
          `Durable Object binding ${binding} has no durableObject setup, so its objects are not reset between runs; add durableObject(${JSON.stringify(binding)}) to the scenario's setup`,
        );
      } else {
        touched.add(id);
        await typed(helpers).runInDurableObject(real, (_instance, live) => {
          watchGate(live);
          state.states.set(id, live);
          return takeOverAlarms(
            live.storage,
            alarmControl(book, binding, id, object, () => ctx.hooks),
          );
        });
      }
    }

    /** A result passed back to the Worker; one that is not plain data cannot be followed. */
    function plain<T>(result: T): T {
      if (!isPlainData(result)) {
        ctx.hooks.unsupported(
          `Durable Object ${binding} ${object} returned something that is not plain data (an RPC capability or an object with methods); calls on it would bypass Eutaxy`,
        );
      }
      return result;
    }

    /**
     * The promise a call returns. On a real stub it is an RPC promise that
     * pipelines property reads (`stub.getData().value`); this one is not, so
     * a read on it makes the run UNSUPPORTED instead of yielding undefined.
     */
    function pipelineGuard<T>(promise: Promise<T>): Promise<T> {
      return new Proxy(promise, {
        get(target, prop) {
          if (
            typeof prop === "symbol" ||
            prop === "then" ||
            prop === "catch" ||
            prop === "finally"
          ) {
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          ctx.hooks.unsupported(
            `Durable Object ${binding} ${object}: RPC promise pipelining (reading .${prop} on a call's promise) is not supported; await the call first`,
          );
          return undefined;
        },
      });
    }

    /** One effect on the object: a method call, or awaiting an RPC property. */
    function onObject(op: string, args: JsonValue, perform: () => Promise<unknown>) {
      return ctx.hooks.effect(
        // The object's own effects during the call (its fetch) belong to this call's turn.
        {
          invocation: ctx.currentInvocation(),
          target,
          op,
          args,
          allowed: CALL,
          hostsEffects: true,
        },
        perform,
        summarize,
        {
          // A crash inside the object's own work leaves its request pending: reset the object.
          onAbandon: () => state.abort(id),
          // Inside blockConcurrencyWhile nothing else enters the object: its effects run at once.
          mayPark: () => state.mayPark(id),
        },
      );
    }

    return new Proxy(stub, {
      get(real, prop, receiver) {
        // A stub is not a promise; `id` and `name` are not calls.
        if (prop === "then") return undefined;
        if (typeof prop !== "string" || prop === "id" || prop === "name")
          return Reflect.get(real, prop, receiver);
        // `stub.method(...)` calls it; `await stub.property` reads an RPC getter. Both are one effect.
        const call = (...args: unknown[]) =>
          pipelineGuard(
            onObject(prop, { object, args: args.map(argument) }, async () => {
              await reach(real);
              // Reflect.apply, not method.apply: an RPC stub's methods are proxies, `.apply` would be a call.
              const method = (real as unknown as Record<string, (...a: unknown[]) => unknown>)[
                prop
              ];
              if (typeof method !== "function")
                throw new TypeError(`${binding} stub has no ${prop}`);
              return plain(await Reflect.apply(method, real, args));
            }),
          );
        const read = () =>
          onObject(prop, { object, property: true }, async () => {
            await reach(real);
            return plain(await (real as unknown as Record<string, unknown>)[prop]);
          });
        const awaitable = (
          onFulfilled?: (v: unknown) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => read().then(onFulfilled, onRejected);
        // Callable and awaitable; any other property read is pipelining, which is not modelled.
        return new Proxy(call, {
          get(target, key) {
            if (key === "then") return awaitable;
            if (typeof key === "symbol") return Reflect.get(target, key);
            ctx.hooks.unsupported(
              `Durable Object ${binding} ${object}: RPC promise pipelining (reading .${prop}.${key}) is not supported; await .${prop} first`,
            );
            return undefined;
          },
        });
      },
    });
  }

  function idFromName(name: string): DurableObjectId {
    const id = real.idFromName(name);
    names.set(id.toString(), name);
    return id;
  }

  return new Proxy(real, {
    get(target, prop, receiver) {
      switch (prop) {
        case "idFromName":
          return idFromName;
        case "idFromString":
          return (hex: string) => target.idFromString(hex);
        case "newUniqueId":
          return (options?: DurableObjectNamespaceNewUniqueIdOptions) => {
            ctx.hooks.unsupported(
              `${binding}.newUniqueId() is random and differs on replay; use idFromName`,
            );
            return target.newUniqueId(options);
          };
        case "get":
          return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
            stubFor(target.get(id, options), id.toString(), nameOf(id));
        case "getByName":
          return (name: string) => {
            const id = idFromName(name);
            return stubFor(target.get(id), id.toString(), name);
          };
        case "jurisdiction":
          return (jurisdiction: DurableObjectJurisdiction) => {
            ctx.hooks.unsupported(
              `${binding}.jurisdiction() namespaces are not proxied or reset; use the namespace itself`,
            );
            return target.jurisdiction(jurisdiction);
          };
        default: {
          // Native methods check their receiver: call them on the real namespace.
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

/**
 * Run an object's `alarm()` handler inside it, after taking over its alarms
 * (the instance may be new since the alarm was set).
 */
/** Drop an object's instance from outside it; one that is not running has nothing to drop. */
export async function evictObject(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers | undefined,
  id: string,
): Promise<void> {
  if (!helpers) return;
  await typed(helpers)
    .evictDurableObject(real.get(real.idFromString(id)))
    .catch(() => {});
}

export function alarmRunner(
  real: DurableObjectNamespace,
  binding: string,
  ctx: ProxyContext,
  helpers: DurableObjectTestHelpers | undefined,
  state: BindingState,
): (
  id: string,
  object: string,
  info: { readonly retryCount: number; readonly isRetry: boolean },
  gen: number,
) => Promise<void> {
  return async (id, object, info, gen) => {
    if (!helpers) {
      ctx.hooks.unsupported(`Durable Object binding ${binding} needs the Cloudflare test helpers`);
      return;
    }
    state.touched.add(id);
    await typed(helpers).runInDurableObject(
      real.get(real.idFromString(id)),
      async (instance, live) => {
        watchGate(live);
        state.states.set(id, live);
        await takeOverAlarms(
          live.storage,
          alarmControl(state.alarms, binding, id, object, () => ctx.hooks),
        );
        // Superseded while the effect waited for its turn: the handler of a cancelled alarm never runs.
        const entry = state.alarms.entry(id);
        if (entry.gen !== gen) return;
        // The alarm is consumed as its handler starts: from here getAlarm() returns null.
        entry.time = null;
        const handler = (instance as { alarm?: (info: unknown) => unknown }).alarm;
        if (typeof handler !== "function") {
          ctx.hooks.unsupported(
            `Durable Object ${binding} ${object} set an alarm but has no alarm() handler`,
          );
          return;
        }
        await handler.call(instance, info);
      },
    );
  };
}

/** The objects to reset: every id the namespace has created, plus the setup's named ones. */
async function objectIds(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  seeded: readonly string[],
): Promise<DurableObjectId[]> {
  const ids = new Map<string, DurableObjectId>();
  for (const id of await typed(helpers).listDurableObjectIds(real)) ids.set(id.toString(), id);
  for (const name of seeded) {
    const id = real.idFromName(name);
    names.set(id.toString(), name);
    ids.set(id.toString(), id);
  }
  return [...ids.values()].sort((a, b) => (a.toString() < b.toString() ? -1 : 1));
}

/**
 * Clear every object of the namespace, write the seeded entries, and evict
 * them all, so each run's first call constructs the object from storage.
 */
export async function resetNamespace(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  objects: { readonly [name: string]: { readonly [key: string]: JsonValue } },
): Promise<void> {
  // Clearing an object constructs it, outside the simulation: its constructor must not reach the network.
  const { requested } = await withoutNetwork(() => clearAndSeed(real, helpers, names, objects));
  if (requested) {
    throw new Error(
      "a Durable Object constructor made a request during reset; constructors run outside the simulation there, so objects whose constructor does I/O are not supported",
    );
  }
}

async function clearAndSeed(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  objects: { readonly [name: string]: { readonly [key: string]: JsonValue } },
): Promise<void> {
  const ids = await objectIds(real, helpers, names, Object.keys(objects));
  for (const id of ids) {
    const stub = real.get(id);
    const name = names.get(id.toString());
    // Own entries only, and only for a known name: an object may be named "" or "__proto__".
    const entries = name !== undefined && Object.hasOwn(objects, name) ? objects[name] : undefined;
    await typed(helpers).runInDurableObject(stub, async (_instance, state) => {
      // Before any constructor of this run: so its blockConcurrencyWhile is seen too.
      watchGate(state);
      await state.storage.deleteAll();
      await deleteRealAlarm(state.storage);
      if (entries && Object.keys(entries).length > 0) await state.storage.put(entries);
    });
    // The object just ran, so eviction can only fail for a real reason: let it fail the reset.
    await typed(helpers).evictDurableObject(stub);
  }
}

/**
 * Each object's storage as rows `{ key, value }`, sorted by key, one table
 * per object name. An object no call reached this run still holds exactly
 * its seed (reset left it evicted), so its rows come from the seed and it is
 * not constructed: its constructor would run outside the simulation. Such an
 * object that is running anyway was reached some other way (through another
 * object's own binding): `onIndirect` is told, and the seed is not its state.
 * The tables are the seeded objects and those a call reached, never objects
 * only earlier runs created, so a snapshot depends on this run alone.
 */
export async function snapshotNamespace(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  touched: ReadonlySet<string>,
  objects: { readonly [name: string]: { readonly [key: string]: JsonValue } },
  onIndirect: (object: string) => void,
  onUnsupported: (reason: string) => void,
): Promise<{ readonly [object: string]: readonly JsonValue[] }> {
  // Reading an object that is no longer running reconstructs it, outside the simulation.
  const { value, requested } = await withoutNetwork(() =>
    readTables(real, helpers, names, touched, objects, onIndirect, onUnsupported),
  );
  if (requested)
    onUnsupported("a Durable Object made a request while its storage was being snapshotted");
  return value;
}

async function readTables(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  touched: ReadonlySet<string>,
  objects: { readonly [name: string]: { readonly [key: string]: JsonValue } },
  onIndirect: (object: string) => void,
  onUnsupported: (reason: string) => void,
): Promise<{ readonly [object: string]: readonly JsonValue[] }> {
  const out: Record<string, JsonValue[]> = {};
  for (const id of await objectIds(real, helpers, names, Object.keys(objects))) {
    const name = names.get(id.toString()) ?? id.toString();
    if (!touched.has(id.toString())) {
      // Eviction only succeeds on a running object, and reset left every object evicted.
      const running = await typed(helpers)
        .evictDurableObject(real.get(id))
        .then(
          () => true,
          () => false,
        );
      if (running) onIndirect(name);
      // Objects earlier runs created stay in the namespace's list: only the seed and this run count.
      if (!Object.hasOwn(objects, name)) continue;
    }
    const entries = touched.has(id.toString())
      ? [
          ...(await typed(helpers).runInDurableObject(real.get(id), (_instance, state) => {
            // Storage Eutaxy never took over belongs to an instance built after the run's calls.
            if (!takenOver.has(state.storage))
              onUnsupported(
                `Durable Object ${name} was reset during the run and reconstructed for the snapshot; its constructor ran outside the simulation`,
              );
            return state.storage.list();
          })),
        ]
      : Object.entries(Object.hasOwn(objects, name) ? (objects[name] ?? {}) : {});
    // Defined, not assigned: an object may be named "__proto__".
    Object.defineProperty(out, name, {
      value: entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value: toJson(value) })),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
