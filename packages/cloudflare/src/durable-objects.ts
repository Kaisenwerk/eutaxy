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

import { canonicalJson, type JsonValue, type RunHooks, toJson, writeFaults } from "@eutaxy/core";
import { withoutNetwork } from "@eutaxy/engine";
import { AlarmBook, alarmControl, takenOver, takeOverAlarms } from "./alarms.ts";
import { envView, hostMethod, hostOf, outsideRunEnv, ownEnv } from "./object-access.ts";
import type { ProxyContext } from "./proxy-context.ts";
import type { DurableObjectSqlSeed, ServiceSetup } from "./scenario.ts";

/** Seeds by object name: key-value entries, and SQL for SQLite-backed objects. */
type Seeds = { readonly [name: string]: { readonly [key: string]: JsonValue } };
type SqlSeeds = { readonly [name: string]: DurableObjectSqlSeed };

/** The SQL surface the seed and the snapshot use, as workerd's `ctx.storage.sql` offers it. */
interface SqlSurface {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** A storage's SQL surface, when the object is SQLite-backed; a key-value object has none that works. */
function sqlOf(storage: unknown): SqlSurface | undefined {
  const sql = (storage as { sql?: unknown }).sql;
  if (typeof sql !== "object" || sql === null || typeof (sql as SqlSurface).exec !== "function")
    return undefined;
  try {
    (sql as SqlSurface).exec("SELECT 1");
    return sql as SqlSurface;
  } catch {
    return undefined;
  }
}

/** A JSON value as SQLite stores it: booleans as 0 and 1, objects and arrays as their JSON text. */
function sqlValue(v: JsonValue): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return v;
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Run a seed: the schema, then one insert per row. */
function seedSql(sql: SqlSurface, seed: DurableObjectSqlSeed): void {
  sql.exec(seed.schema);
  for (const [table, rows] of Object.entries(seed.rows ?? {}))
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) {
        // Every column defaulted or generated: still one row.
        sql.exec(`INSERT INTO ${quoted(table)} DEFAULT VALUES`);
        continue;
      }
      sql.exec(
        `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((c) => sqlValue(row[c] as JsonValue)),
      );
    }
}

/** The user tables of a SQLite-backed object: not SQLite's own, not the runtime's (`_cf_*`, the key-value API's among them). */
function userTables(sql: SqlSurface): string[] {
  return sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    )
    .toArray()
    .map((r) => String(r["name"]));
}

/** Each user table of a SQLite-backed object with its rows, as the storage holds them. */
function readSqlTables(sql: SqlSurface): [string, JsonValue[]][] {
  return userTables(sql).map((t) => [
    t,
    sortedRows(sql.exec(`SELECT * FROM ${quoted(t)}`).toArray()),
  ]);
}

/** The SQL tables each seeded object held right after its seed, as the snapshot of an object the run never reached. */
export type SeededSql = Map<string, [string, JsonValue[]][]>;

/** A table's rows in a fixed order: a table has none of its own, so the canonical JSON of each row decides. */
function sortedRows(rows: readonly Record<string, unknown>[]): JsonValue[] {
  return rows
    .map((r) => toJson(r))
    .sort((a, b) => {
      const x = canonicalJson(a);
      const y = canonicalJson(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

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
 * By object id, the host an object's code runs as and the run it runs in,
 * noted before each entry into the object: what its constructor does on the
 * way in has no other way to know whose code it is.
 */
const hostOfId = new Map<
  string,
  {
    readonly hooks: () => RunHooks;
    readonly host: string;
    readonly binding: string;
    readonly object: string;
    /** The platform's proxy context: its env answers the object's bindings, its slot carries the gate. */
    readonly ctx: ProxyContext;
    /** Told the instance's state as soon as it is constructed: the gate it may hold is watched from then. */
    readonly constructed: (state: DurableObjectState) => void;
  }
>();

/**
 * Whether the platform is running a scenario (from its reset to its
 * cleanup). Only then is a construction the scenario's: the base a class
 * was given stays on it, and outside the platform's runs (the differential
 * runner's raw side, which compares against the real bindings) it hands
 * the runtime's env on untouched.
 */
let simulating = false;

/** Tell that the platform's run of a scenario begins or is over. */
export function simulatingConstruction(on: boolean): void {
  simulating = on;
  if (!on) hostOfId.clear();
}

/** Forget every object's host: a new run notes them again as it enters each. */
export function forgetHosts(): void {
  hostOfId.clear();
}

/** The scenario's service scripts by binding, for what a constructor calls while its object is reset. */
let scriptedOutsideRuns: (binding: string) => ServiceSetup | undefined = () => undefined;

/** Tell which service bindings the scenario being reset scripts (see `outsideRunEnv`). */
export function scriptsOutsideRuns(scripted: (binding: string) => ServiceSetup | undefined): void {
  scriptedOutsideRuns = scripted;
}

/** The bases the platform gave to Durable Object classes (`simulateConstruction`). */
const simulatedBases = new WeakSet<object>();

/**
 * Give each Durable Object class among a module's exports a base that hands
 * its constructor the scenario's view of env (`envView`), so that
 * `this.env` is the scenario's from the constructor's first line: a call
 * the constructor makes through a service binding is answered as any of the
 * object's is. The class that extends the runtime's `DurableObject` (found
 * by name, as the entrypoint bases are) is made to extend a class of the
 * platform's that extends it in turn; the runtime constructs the same
 * class as before. Outside a run (the reset) the constructor is given an
 * env whose service bindings refuse. A class the platform is not given, or
 * the `env` parameter a constructor keeps for itself, is out of reach.
 */
export function simulateConstruction(exports: Readonly<Record<string, unknown>> | undefined): void {
  for (const value of Object.values(exports ?? {})) {
    if (typeof value !== "function") continue;
    // The class that extends the runtime's base directly, unless it was given a base already.
    let direct: object | undefined = value;
    while (direct !== undefined) {
      const parent = Object.getPrototypeOf(direct) as unknown;
      if (
        typeof parent !== "function" ||
        parent === Function.prototype ||
        simulatedBases.has(parent)
      )
        direct = undefined;
      else if ((parent as { name: string }).name === "DurableObject") break;
      else direct = parent;
    }
    if (direct === undefined) continue;
    const real = Object.getPrototypeOf(direct) as new (state: unknown, env: unknown) => object;
    const base = class extends real {
      constructor(state: unknown, env: unknown) {
        super(state, constructionEnv(state, env));
      }
    };
    // Still the runtime's base to anything that looks for it by name.
    Object.defineProperty(base, "name", { value: "DurableObject" });
    simulatedBases.add(base);
    Object.setPrototypeOf(direct, base);
    Object.setPrototypeOf((direct as { prototype: object }).prototype, base.prototype);
  }
}

/** The env a class given a simulated base is constructed with: the entering run's view, or the refusing one outside a run. */
function constructionEnv(state: unknown, env: unknown): unknown {
  if (!simulating || env === null || typeof env !== "object") return env;
  const id = (state as { id?: { toString(): string } } | null)?.id;
  const of = id === undefined ? undefined : hostOfId.get(id.toString());
  if (!of) return outsideRunEnv(env, scriptedOutsideRuns);
  // Before the constructor's own code runs: a gate it takes is seen, and its effects wait behind it.
  // The gate is watched from here too: for an object nobody seeded, no reset has installed that yet.
  watchGate(state as DurableObjectState);
  of.constructed(state as DurableObjectState);
  const sync = (state as { storage?: { sync?: () => Promise<void> } }).storage?.sync;
  const storage = (state as { storage?: object }).storage;
  return envView(
    env,
    { hooks: of.hooks(), binding: of.binding, object: of.object },
    of.ctx.env,
    of.ctx.gate && typeof sync === "function"
      ? { slot: of.ctx.gate, durable: () => sync.call(storage) }
      : undefined,
  );
}

/**
 * Record when an object holds its input gate with blockConcurrencyWhile,
 * on the state prototype so constructors are covered too, and run what it
 * holds the gate for as the object's code (`RunHooks.hostEntering`): a
 * constructor's work behind the gate has no context of the call entering
 * the object, and a timer it awaited would be nobody's to fire. Inside a
 * method the code is the object's already and runs as it is.
 */
function watchGate(state: DurableObjectState): void {
  const proto = Object.getPrototypeOf(state) as {
    blockConcurrencyWhile?: (cb: () => Promise<unknown>) => Promise<unknown>;
  };
  if (!proto || gateWatched.has(proto) || typeof proto.blockConcurrencyWhile !== "function") return;
  gateWatched.add(proto);
  const native = proto.blockConcurrencyWhile;
  proto.blockConcurrencyWhile = function (this: object, callback: () => Promise<unknown>) {
    const held = async (): Promise<unknown> => {
      gateDepth.set(this, (gateDepth.get(this) ?? 0) + 1);
      try {
        return await callback();
      } finally {
        gateDepth.set(this, (gateDepth.get(this) ?? 1) - 1);
      }
    };
    const id = (this as { id?: { toString(): string } }).id;
    const of = !simulating || id === undefined ? undefined : hostOfId.get(id.toString());
    return native.call(this, of ? () => of.hooks().hostEntering(of.host, held) : held);
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
  /**
   * Ids of the objects whose instance a crash dropped (a reset inside the
   * object, or its eviction after one) and nothing has entered since. One
   * still here when the run would end is woken inside the run (`wakeEvents`).
   */
  readonly dropped = new Set<string>();
  /** The SQL tables the seed left in each seeded object, materialized, for the snapshot of one never reached. */
  seededSql: SeededSql = new Map();

  /** Whether the object's own effects may wait for a turn: not while it holds its input gate. */
  mayPark(id: string): boolean {
    return !gateHeld(this.states.get(id));
  }

  clear(): void {
    this.names.clear();
    this.touched.clear();
    this.alarms.clear();
    this.states.clear();
    this.dropped.clear();
    this.seededSql = new Map();
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
    this.dropped.add(id);
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
  const { names } = state;
  const nameOf = (id: DurableObjectId) => names.get(id.toString()) ?? id.toString();

  function stubFor(stub: DurableObjectStub, id: string, object: string): DurableObjectStub {
    /** Make sure the call may reach the object, take over its alarms first, and host the method about to run. */
    async function reach(real: DurableObjectStub, method?: string): Promise<void> {
      if (!helpers) {
        ctx.hooks.unsupported(
          `Durable Object binding ${binding} needs the Cloudflare test helpers (pass durableObjects to createCloudflarePlatform)`,
        );
      } else if (!isReset()) {
        ctx.hooks.unsupported(
          `Durable Object binding ${binding} has no durableObject setup, so its objects are not reset between runs; add durableObject(${JSON.stringify(binding)}) to the scenario's setup`,
        );
      } else {
        await enterObject(real, binding, ctx, helpers, state, id, object, async (instance) => {
          if (method !== undefined) hostMethod(ctx.hooks, hostOf(target, object), instance, method);
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
          allowed: writeFaults,
          hostsEffects: true,
        },
        perform,
        summarize,
        {
          // The object's code is the host's: inside the call its effects are the call's; after the
          // answer, work it goes on with is the object's own turns.
          host: hostOf(target, object),
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
              await reach(real, prop);
              // Reflect.apply, not method.apply: an RPC stub's methods are proxies, `.apply` would be a call.
              const method = (real as unknown as Record<string, (...a: unknown[]) => unknown>)[
                prop
              ];
              if (typeof method !== "function")
                throw new TypeError(`${binding} stub has no ${prop}`);
              const result = await Reflect.apply(method, real, args);
              // A 101 from the object's fetch: a WebSocket connection now reaches this object.
              if (
                prop === "fetch" &&
                result instanceof Response &&
                result.status === 101 &&
                result.webSocket
              )
                ctx.onUpgrade?.({
                  binding,
                  id,
                  object,
                  invocation: ctx.currentInvocation(),
                  client: result.webSocket,
                });
              return plain(result);
            }),
          );
        const read = () =>
          onObject(prop, { object, property: true }, async () => {
            await reach(real, prop);
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
            if (options?.jurisdiction !== undefined) {
              ctx.hooks.unsupported(
                `${binding}.newUniqueId({ jurisdiction }) ids are not proxied or reset; use newUniqueId() without one`,
              );
              return target.newUniqueId(options);
            }
            // Natively the id is random. Drawn from the run's random stream it repeats on replay, and the
            // draw counts as a read of randomness, as it must: which id an invocation gets depends on
            // the order of turns. The id is a named one (its name is the draw), so the real namespace
            // accepts it and the reset finds its object; a Worker reading `id.name` sees that name.
            return idFromName(`eutaxy:unique:${crypto.randomUUID()}`);
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

/**
 * Run code inside an object as one of its own events does (an alarm, a
 * WebSocket message): the object is marked reached, its gate watched, its
 * alarms taken over, then `fn` runs with the instance and its state.
 */
export async function runInObject<T>(
  real: DurableObjectNamespace,
  binding: string,
  ctx: ProxyContext,
  helpers: DurableObjectTestHelpers | undefined,
  state: BindingState,
  id: string,
  object: string,
  fn: (instance: unknown, live: DurableObjectState) => Promise<T>,
): Promise<T | undefined> {
  if (!helpers) {
    ctx.hooks.unsupported(`Durable Object binding ${binding} needs the Cloudflare test helpers`);
    return undefined;
  }
  return enterObject(real.get(real.idFromString(id)), binding, ctx, helpers, state, id, object, fn);
}

/**
 * Enter an object through a stub for a call or an event of its own: the
 * object is marked reached, its gate watched, its state kept for the run,
 * its alarms taken over, then `fn` runs with the instance and its state.
 */
function enterObject<T>(
  stub: DurableObjectStub,
  binding: string,
  ctx: ProxyContext,
  helpers: DurableObjectTestHelpers,
  state: BindingState,
  id: string,
  object: string,
  fn: (instance: unknown, live: DurableObjectState) => Promise<T>,
): Promise<T> {
  state.touched.add(id);
  // Whoever enters the object constructs it, inside the run: no need to wake it at the end.
  state.dropped.delete(id);
  // Known before the runtime constructs the instance: its constructor's work is this object's.
  hostOfId.set(id, {
    hooks: () => ctx.hooks,
    host: hostOf(`DO:${binding}`, object),
    binding,
    object,
    ctx,
    constructed: (live) => void state.states.set(id, live),
  });
  return typed(helpers).runInDurableObject(stub, async (instance, live) => {
    watchGate(live);
    state.states.set(id, live);
    await takeOverAlarms(
      live.storage,
      alarmControl(state.alarms, binding, id, object, () => ctx.hooks),
    );
    // What the object wrote is durable before a call of its own leaves it, as behind the output gate.
    const sync = (live.storage as { sync?: () => Promise<void> }).sync;
    ownEnv(
      ctx.hooks,
      binding,
      object,
      instance,
      ctx.env,
      ctx.gate && typeof sync === "function"
        ? { slot: ctx.gate, durable: () => sync.call(live.storage) }
        : undefined,
    );
    return fn(instance, live);
  });
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
  objects: Seeds,
  sql: SqlSeeds = {},
): Promise<SeededSql> {
  // Clearing an object constructs it, outside the simulation: its constructor must not reach the network.
  const { value, requested } = await withoutNetwork(() =>
    clearAndSeed(real, helpers, names, objects, sql),
  );
  if (requested) {
    throw new Error(
      "a Durable Object constructor made a request during reset; constructors run outside the simulation there, so objects whose constructor does I/O are not supported",
    );
  }
  return value;
}

/** The names a setup seeds: those with key-value entries and those with SQL. */
const seededNames = (objects: Seeds, sql: SqlSeeds): string[] => [
  ...new Set([...Object.keys(objects), ...Object.keys(sql)]),
];

async function clearAndSeed(
  real: DurableObjectNamespace,
  helpers: DurableObjectTestHelpers,
  names: ObjectNames,
  objects: Seeds,
  sql: SqlSeeds,
): Promise<SeededSql> {
  const seededSql: SeededSql = new Map();
  const ids = await objectIds(real, helpers, names, seededNames(objects, sql));
  for (const id of ids) {
    const stub = real.get(id);
    const name = names.get(id.toString());
    // Own entries only, and only for a known name: an object may be named "" or "__proto__".
    const entries = name !== undefined && Object.hasOwn(objects, name) ? objects[name] : undefined;
    const seed = name !== undefined && Object.hasOwn(sql, name) ? sql[name] : undefined;
    await typed(helpers).runInDurableObject(stub, async (_instance, state) => {
      // Before any constructor of this run: so its blockConcurrencyWhile is seen too.
      watchGate(state);
      // deleteAll drops SQL and key-value data alike (Cloudflare, Storage API).
      await state.storage.deleteAll();
      await deleteRealAlarm(state.storage);
      if (entries && Object.keys(entries).length > 0) await state.storage.put(entries);
      if (seed) {
        const surface = sqlOf(state.storage);
        if (!surface)
          throw new Error(
            `Durable Object ${name} has a sql seed but is not SQLite-backed (no working ctx.storage.sql); add its class to new_sqlite_classes in the wrangler migrations`,
          );
        seedSql(surface, seed);
        // What the seed left, as SQLite holds it (defaults, generated ids, affinities), for the snapshot
        // of this object when no call reaches it.
        seededSql.set(name as string, readSqlTables(surface));
      }
    });
    // The object just ran, so eviction can only fail for a real reason: let it fail the reset.
    await typed(helpers).evictDurableObject(stub);
  }
  return seededSql;
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
  objects: Seeds,
  sql: SqlSeeds,
  seededSql: SeededSql,
  onIndirect: (object: string) => void,
  onUnsupported: (reason: string) => void,
  /** Read every seeded object's storage, touched or not, as the raw side of a differential does: no proxy saw its calls. */
  all = false,
): Promise<{ readonly [object: string]: readonly JsonValue[] }> {
  // Reading an object that is no longer running reconstructs it, outside the simulation.
  const { value, requested } = await withoutNetwork(() =>
    readTables(
      real,
      helpers,
      names,
      touched,
      objects,
      sql,
      seededSql,
      onIndirect,
      onUnsupported,
      all,
    ),
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
  objects: Seeds,
  sql: SqlSeeds,
  seededSql: SeededSql,
  onIndirect: (object: string) => void,
  onUnsupported: (reason: string) => void,
  all: boolean,
): Promise<{ readonly [object: string]: readonly JsonValue[] }> {
  const out: Record<string, JsonValue[]> = {};
  // Defined, not assigned: an object may be named "__proto__". Names may not hold "/", so a table's
  // key never collides with an object's; a collision anyway is a bug, never a silent overwrite.
  const define = (table: string, rows: JsonValue[]) => {
    if (Object.hasOwn(out, table)) throw new Error(`snapshot key ${table} named twice`);
    Object.defineProperty(out, table, {
      value: rows,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  const seeded = seededNames(objects, sql);
  for (const id of await objectIds(real, helpers, names, seeded)) {
    const name = names.get(id.toString()) ?? id.toString();
    // The raw side of a differential reads every object, a call's own unseeded one included; the
    // stale empties earlier runs left read the same on both sides.
    const read = all || touched.has(id.toString());
    if (!read) {
      // Eviction only succeeds on a running object, and reset left every object evicted.
      const running = await typed(helpers)
        .evictDurableObject(real.get(id))
        .then(
          () => true,
          () => false,
        );
      if (running) onIndirect(name);
      // Objects earlier runs created stay in the namespace's list: only the seed and this run count.
      if (!seeded.includes(name)) continue;
    }
    let entries: [string, unknown][];
    const tables: [string, JsonValue[]][] = [];
    if (read) {
      const read = await typed(helpers).runInDurableObject(real.get(id), (_instance, state) => {
        // Storage Eutaxy never took over belongs to an instance built after the run's calls.
        if (!all && !takenOver.has(state.storage))
          onUnsupported(
            `Durable Object ${name} was reset during the run and reconstructed for the snapshot; its constructor ran outside the simulation`,
          );
        const surface = sqlOf(state.storage);
        const sqlTables: [string, JsonValue[]][] = surface ? readSqlTables(surface) : [];
        return Promise.resolve(state.storage.list()).then((kv) => ({ kv: [...kv], sqlTables }));
      });
      entries = read.kv;
      tables.push(...read.sqlTables);
    } else {
      // Untouched: exactly the seed, the key-value entries as given and the SQL tables as the reset
      // read them back after seeding.
      entries = Object.entries(Object.hasOwn(objects, name) ? (objects[name] ?? {}) : {});
      tables.push(...(seededSql.get(name) ?? []));
    }
    define(
      name,
      entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value: toJson(value) })),
    );
    for (const [table, rows] of tables) define(`${name}/${table}`, rows);
  }
  return out;
}
