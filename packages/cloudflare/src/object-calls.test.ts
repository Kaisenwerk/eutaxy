/**
 * Calls between objects, in Node against fake namespaces: a call an object
 * makes into another object through `this.env` is the scenario's, an
 * effect of the invocation the calling object's code runs as, hosting what
 * the called object does, and open to its faults. The real objects run in
 * workerd in the corpus.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http } from "./scenario.ts";

/** What the objects' storages did, in order, and the objects a fault reset. */
let order: string[] = [];
let reset: string[] = [];
/** Results of the shelf's that were disposed. */
let disposed = 0;
const disposer = (Symbol as unknown as { readonly dispose: symbol }).dispose;

/** A storage whose `sync()` is the runtime's: it makes the writes before it durable. */
class GatedStorage extends FakeStorage {
  readonly owner: string;
  constructor(backing: Backing, owner: string) {
    super(backing);
    this.owner = owner;
  }
  override async put(key: string | Record<string, unknown>, value?: unknown) {
    order.push(`${this.owner} put ${String(key)}`);
    return super.put(key, value);
  }
  async sync(): Promise<void> {
    order.push(`${this.owner} sync`);
  }
}

type Namespace<T> = { idFromName(name: string): unknown; get(id: unknown): T };
type Env = { CART: Namespace<Cart>; SHELF: Namespace<Shelf>; LOG: Namespace<Log>; LIMIT: number };

class Base {
  readonly ctx: { storage: FakeStorage };
  env: Env;
  constructor(storage: FakeStorage, env: object) {
    this.ctx = { storage };
    this.env = env as Env;
  }
}

class Log extends Base {
  async note(entry: string) {
    await this.ctx.storage.put("noted", entry);
    return { noted: entry };
  }
}

class Shelf extends Base {
  /** Records the take, then tells the log before it answers. */
  async take(cart: string) {
    await this.ctx.storage.put("taken", cart);
    await this.env.LOG.get(this.env.LOG.idFromName("log")).note(cart);
    // As the runtime's RPC results are: disposable.
    return { taken: true, [disposer]: () => void disposed++ };
  }
}

class Cart extends Base {
  /** Inside the call: its own note, then the shelf, then the item it keeps. */
  async add(item: string) {
    await this.ctx.storage.put("asked", item);
    const { taken } = await this.env.SHELF.get(this.env.SHELF.idFromName(item)).take("c1");
    await this.ctx.storage.put("kept", item);
    return { added: taken };
  }
  /** Answers at once; the shelf is asked in work queued behind the answer. */
  async later(item: string) {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await this.env.SHELF.get(this.env.SHELF.idFromName(item)).take("c1");
    })().catch(() => {});
    return "accepted";
  }
  /** Hands the shelf's answer on as its own. */
  async through(item: string) {
    return this.env.SHELF.get(this.env.SHELF.idFromName(item)).take("c1");
  }
  /** Builds a stub from its env and calls nothing. */
  async idle(item: string) {
    const stub = this.env.SHELF.get(this.env.SHELF.idFromName(item));
    return typeof stub === "object" ? this.env.LIMIT : -1;
  }
}

const stubOf = Symbol("the fake runtime's handle on a stub's object");
type Instance = Base & Record<string, (...args: unknown[]) => unknown>;

/** A namespace as the runtime gives it, constructing `cls` with the Worker's real env. */
function fakeNamespace(
  label: string,
  cls: new (s: FakeStorage, env: object) => Base,
  envOf: () => object,
) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Instance>();
  const instanceOf = (hex: string): Instance => {
    let i = instances.get(hex);
    if (!i) {
      let backing = storages.get(hex);
      if (!backing) {
        backing = new Backing();
        storages.set(hex, backing);
      }
      i = new cls(new GatedStorage(backing, `${label}:${hex}`), envOf()) as Instance;
      instances.set(hex, i);
    }
    return i;
  };
  const idFor = (hex: string) => ({ toString: () => hex, equals: () => false });
  const namespace = {
    idFromName: (name: string) => idFor(`id-${name}`),
    idFromString: (hex: string) => idFor(hex),
    jurisdiction: () => namespace,
    newUniqueId: () => idFor("id-random"),
    get: (id: { toString(): string }) => {
      const hex = id.toString();
      const handle = {
        run: (callback: (instance: unknown, state: object) => unknown) => {
          const instance = instanceOf(hex);
          return callback(instance, {
            storage: instance.ctx.storage,
            abort: () => {
              reset.push(`${label}:${hex}`);
              instances.delete(hex);
            },
          });
        },
        evict: () => instances.delete(hex),
      };
      return new Proxy({ id } as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop === stubOf) return handle;
          if (prop === "id" || typeof prop === "symbol" || prop === "then") return target[prop];
          return (...args: unknown[]) => instanceOf(hex)[prop]?.(...args);
        },
      });
    },
  };
  return { namespace, storages, ids: () => [...storages.keys()].map(idFor) };
}

type Handle = {
  run(callback: (instance: unknown, state: object) => unknown): unknown;
  evict(): boolean;
};
const handleOf = (stub: unknown) => (stub as { [stubOf]: Handle })[stubOf];

type Method = "add" | "later" | "through" | "idle";

/** A Worker whose request calls the method its path names on the cart "c1", for the item "widget". */
const handlerFor = (binding: string): WorkerHandler => ({
  async fetch(request, env) {
    const ns = (env as Record<string, Namespace<Record<Method, (i: string) => unknown>>>)[binding];
    const method = new URL(request.url).pathname.slice(1) as Method;
    try {
      return Response.json({ value: await ns?.get(ns.idFromName("c1"))[method]("widget") });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
});

async function runOf(
  path: string,
  options: {
    faults?: Schedule["faults"];
    /** The binding names, when the objects are a callee's: `<name>/CART`, `<name>/SHELF`. */
    callee?: string;
    /** Leave the shelf's namespace out of the setup. */
    noShelfStep?: boolean;
  } = {},
) {
  order = [];
  reset = [];
  disposed = 0;
  const q = (name: string) => (options.callee === undefined ? name : `${options.callee}/${name}`);
  const env: Record<string, unknown> = {};
  const envOf = () => (options.callee === undefined ? env : calleeEnv(options.callee, env));
  const carts = fakeNamespace("cart", Cart, envOf);
  const shelves = fakeNamespace("shelf", Shelf, envOf);
  const logs = fakeNamespace("log", Log, envOf);
  const all = [carts, shelves, logs];
  Object.assign(env, {
    [q("CART")]: carts.namespace,
    [q("SHELF")]: shelves.namespace,
    [q("LOG")]: logs.namespace,
    [q("LIMIT")]: 3,
  });
  const platform = createCloudflarePlatform({
    env,
    handler: handlerFor(q("CART")),
    schemas: {},
    durableObjects: {
      runInDurableObject: async (
        stub: unknown,
        callback: (instance: unknown, state: object) => unknown,
      ) => handleOf(stub).run(callback),
      evictDurableObject: async (stub: unknown) => {
        if (!handleOf(stub).evict()) throw new Error("not running");
      },
      listDurableObjectIds: async (namespace: unknown) =>
        all.find((n) => n.namespace === namespace)?.ids() ?? [],
    },
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "carts",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path, method: "POST" }], { retries: 0 }),
    setup: [
      durableObject(q("CART"), { c1: {} }),
      ...(options.noShelfStep ? [] : [durableObject(q("SHELF"), { widget: {} })]),
      durableObject(q("LOG"), { log: {} }),
    ],
    externals: [],
    invariants: [],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 0,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };
  const run = new Run({
    chooser: replayChooser({ seed: 1, faults: options.faults ?? [] }),
    bounds: s.bounds,
  });
  const log = await runOnce(s, platform, run);
  return {
    log,
    run,
    cart: carts.storages.get("id-c1")?.data,
    shelf: shelves.storages.get("id-widget")?.data,
  };
}

const lines = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

const fault = (
  ordinal: number,
  kind: "crash_before" | "crash_after" | "ambiguous",
  target: string,
  op: string,
): Schedule["faults"] => [{ invocation: "req-1#1", ordinal, fault: kind, target, op }];

describe("an object's call into another object", () => {
  test("inside a call it is an effect of the calling invocation, hosting what the called object does", async () => {
    const { log, run, cart, shelf } = await runOf("/add");
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(0, 6)).toEqual([
      "req-1#1 call DO:CART add",
      "req-1#1 call DO:SHELF take",
      "req-1#1 call DO:LOG note",
      "req-1#1 result DO:LOG note",
      "req-1#1 result DO:SHELF take",
      "req-1#1 result DO:CART add",
    ]);
    expect(cart?.get("kept")).toBe("widget");
    expect(shelf?.get("taken")).toBe("c1");
  });

  test("it leaves the calling object once that object's earlier writes are durable", async () => {
    await runOf("/add");
    expect(order).toEqual([
      "cart:id-c1 put asked",
      "cart:id-c1 sync",
      "shelf:id-widget put taken",
      "shelf:id-widget sync",
      "log:id-log put noted",
      "cart:id-c1 put kept",
    ]);
  });

  test("a crash inside the called object ends the invocation: every object on the way in is reset, innermost first", async () => {
    // The log is called by the shelf, which the cart is waiting on.
    const { log, run, cart } = await runOf("/add", {
      faults: fault(2, "crash_before", "DO:LOG", "note"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 fault DO:LOG note");
    expect(reset).toEqual(["shelf:id-widget", "cart:id-c1"]);
    expect(cart?.get("kept")).toBeUndefined();
  });

  test("an answer lost on its way back is an error in the calling object, which goes on", async () => {
    const { log, run, cart, shelf } = await runOf("/add", {
      faults: fault(1, "ambiguous", "DO:SHELF", "take"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 fault DO:SHELF take");
    // The shelf acted; the cart got an error, kept nothing, and was not reset.
    expect(shelf?.get("taken")).toBe("c1");
    expect(cart?.get("kept")).toBeUndefined();
    expect(reset).toEqual([]);
  });

  test("the calling object dying after the call resets it and not the object it called", async () => {
    const { run, cart, shelf } = await runOf("/add", {
      faults: fault(1, "crash_after", "DO:SHELF", "take"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(reset).toEqual(["cart:id-c1"]);
    expect(shelf?.get("taken")).toBe("c1");
    // What the cart wrote before the call was durable before it left.
    expect(cart?.get("asked")).toBe("widget");
    expect(cart?.get("kept")).toBeUndefined();
  });

  test("in work after its answer the call is the calling object's own invocation's", async () => {
    const { log, run, shelf } = await runOf("/later");
    expect(run.unsupportedReasons).toEqual([]);
    const all = lines(log);
    expect(all).toContain("DO:CART/c1/after call DO:SHELF take");
    expect(all).toContain("DO:CART/c1/after call DO:LOG note");
    expect(all.indexOf("DO:CART/c1/after call DO:SHELF take")).toBeGreaterThan(
      all.indexOf("req-1#1 result DO:CART later"),
    );
    expect(shelf?.get("taken")).toBe("c1");
  });

  test("an answer handed on as the calling object's own reaches the Worker as data", async () => {
    const { log, run } = await runOf("/through");
    expect(run.unsupportedReasons).toEqual([]);
    const answer = log.entries.find((e) => e.kind === "result" && e.op === "through");
    expect((answer?.payload as { result?: unknown } | undefined)?.result).toEqual({ taken: true });
    // The runtime's own result keeps the call's session open until disposed: the model disposed
    // it, and the cart handed on a copy.
    expect(disposed).toBe(1);
  });

  test("a callee's objects call each other under the callee's names", async () => {
    const { log, run } = await runOf("/add", { callee: "shop" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(0, 3)).toEqual([
      "req-1#1 call DO:shop/CART add",
      "req-1#1 call DO:shop/SHELF take",
      "req-1#1 call DO:shop/LOG note",
    ]);
  });

  test("getting a stub calls nothing, and a namespace without a setup step is refused as from the Worker", async () => {
    const idle = await runOf("/idle", { noShelfStep: true });
    expect(idle.run.unsupportedReasons).toEqual([]);
    expect(lines(idle.log).slice(0, 2)).toEqual([
      "req-1#1 call DO:CART idle",
      "req-1#1 result DO:CART idle",
    ]);
    const used = await runOf("/add", { noShelfStep: true });
    expect(used.run.unsupportedReasons.join()).toContain(
      "Durable Object binding SHELF has no durableObject setup",
    );
  });
});
