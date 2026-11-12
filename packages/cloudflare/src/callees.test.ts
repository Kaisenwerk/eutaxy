/**
 * Service bindings with the callee real, in Node with a stand-in for the
 * runtime's `WorkerEntrypoint`: each call hosts the callee's invocation, whose
 * effects are its own under qualified targets; what it throws crosses as RPC
 * carries it; a fault inside it is an error to the caller; the call's own
 * faults are a call's.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv, callFaults, crossingError } from "./callees.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { callee, defineScenario, queue, service } from "./scenario.ts";

/** The runtime's base class, as far as construction goes: it is found by name. */
class WorkerEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** A test double for the runtime's Fetcher: fetch and connect, and a record of being called. */
class FakeFetcher {
  calls = 0;
  async fetch(): Promise<Response> {
    this.calls++;
    return new Response("real");
  }
  connect(): never {
    this.calls++;
    throw new Error("real connect");
  }
}

/** A plain value in env that is not a binding (no prototype methods to mistake for one). */
type Log = { readonly calls: string[] };
const log = (): Log => Object.assign(Object.create(null) as object, { calls: [] as string[] });

interface CalleeEnv {
  readonly LOG: Log;
  readonly PARTNER: { quote(orderId: string): Promise<number> };
}

/** The inventory Worker: reserve() asks its own partner (a scripted service of its own) and records the call. */
class Inventory extends WorkerEntrypoint<CalleeEnv> {
  static constructed = 0;
  constructor(ctx: ExecutionContext, env: CalleeEnv) {
    super(ctx, env);
    Inventory.constructed++;
  }
  async reserve(orderId: string, qty: number) {
    this.env.LOG.calls.push(`reserve ${orderId}`);
    const quote = await this.env.PARTNER.quote(orderId);
    return { orderId, qty, quote, keys: Object.keys(this.env).sort() };
  }
  fail(message: string): never {
    const error = new RangeError(message);
    (error as unknown as { code: number }).code = 7;
    throw error;
  }
  later(): string {
    this.ctx.waitUntil(Promise.resolve().then(() => this.env.LOG.calls.push("later")));
    return "answered";
  }
  stub(): object {
    return { release: () => 0 };
  }
  get price(): number {
    return 42;
  }
  /** An instance field: not reachable over RPC. */
  field = "set";
  /** What the caller's binding carries: the callee reads who called. */
  whoCalled(): unknown {
    return (this.ctx as { props: unknown }).props;
  }
  /** What the callee sees of an argument the caller changed after calling. */
  take(order: { qty: number }): number {
    return order.qty;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/throw") throw new TypeError("bad request");
    if (path === "/moved") return Response.redirect("https://inventory.internal/here", 302);
    return Response.json({ got: await request.text(), path });
  }
}

/** The runtime's Workflow base class, as far as construction goes: found by name. */
class WorkflowEntrypoint<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** A Workflow of the callee's: its run writes to the callee's own LOG. */
class Fulfilment extends WorkflowEntrypoint<CalleeEnv> {
  async run(
    event: { payload: { id: string } },
    step: { do(n: string, f: () => unknown): unknown },
  ) {
    await step.do("record", () => {
      this.env.LOG.calls.push(`fulfilled ${event.payload.id}`);
      return null;
    });
    return "done";
  }
}

/** Starts a Workflow of the callee's. */
class Shipping extends WorkerEntrypoint<
  CalleeEnv & { FLOW: { create(o: { id: string; params: unknown }): Promise<unknown> } }
> {
  async ship(id: string): Promise<string> {
    await this.env.FLOW.create({ id, params: { id } });
    return id;
  }
}

/** A nested callee: the partner the inventory Worker calls, with a scripted service of its own. */
class Partner extends WorkerEntrypoint<{ RATES: { rate(): Promise<number> } }> {
  async quote(orderId: string): Promise<number> {
    return (await this.env.RATES.rate()) * orderId.length;
  }
}

class Other extends WorkerEntrypoint {
  ping(): string {
    return "pong";
  }
  async fetch(request: Request): Promise<Response> {
    return Response.json({ other: new URL(request.url).pathname });
  }
}

const inventoryModule = { default: Inventory, Other, Fulfilment, Shipping };
const partnerModule = { default: Partner };

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 1,
  maxConcurrentInvocations: 1,
  budgetMs: 10_000,
};

const inventory = callee("INVENTORY", {
  entry: "./inventory/worker.ts",
  config: "./inventory/wrangler.jsonc",
});
const partner = service("inventory/PARTNER", { methods: { quote: { returns: 12 } } });

function spec(setup: ScenarioSpec["setup"]): ScenarioSpec {
  return {
    version: 1,
    name: "callees",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: queue("q", [{ body: { orderId: "o-1" } }]),
    setup,
    externals: [],
    invariants: [],
    bounds,
  };
}

type Stub = Record<string, (...args: unknown[]) => Promise<unknown>> & {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  price: Promise<number>;
};

async function run(
  s: ScenarioSpec,
  handler: (stub: Stub, calleeLog: Log) => Promise<unknown>,
  faults: Schedule["faults"] = [],
  /** The callees given to the platform; null for none. */
  callees: Record<
    string,
    {
      name: string;
      exports: Record<string, unknown>;
      entrypoint?: string;
      props?: Record<string, string>;
      self?: boolean;
    }
  > | null = {
    INVENTORY: { name: "inventory", exports: inventoryModule },
  },
  extraEnv: Record<string, unknown> = {},
  extraOptions: { aliases?: Record<string, string> } = {},
) {
  const real = new FakeFetcher();
  const calleeLog = log();
  const seen: unknown[] = [];
  const queueHandler: WorkerHandler = {
    async queue(_batch, env) {
      try {
        seen.push(await handler((env as { INVENTORY: Stub }).INVENTORY, calleeLog));
      } catch (err) {
        seen.push(err);
        throw err;
      }
    },
  };
  const platform = createCloudflarePlatform({
    env: {
      INVENTORY: real,
      "inventory/PARTNER": new FakeFetcher(),
      "inventory/LOG": calleeLog,
      ...extraEnv,
    },
    handler: queueHandler,
    schemas: {},
    ...(callees === null ? {} : { callees }),
    ...extraOptions,
  });
  const r = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds });
  const logOut = await runOnce(s, platform, r);
  return { log: logOut, run: r, real, seen, calleeLog };
}

const lines = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

describe("a method call through the binding", () => {
  test("hosts the callee's invocation: its effects are its own, under qualified targets, and the real binding is never called", async () => {
    Inventory.constructed = 0;
    const {
      log,
      real,
      seen,
      run: r,
    } = await run(spec([inventory, partner]), async (stub) => [
      await stub["reserve"]?.("o-1", 2),
      await stub["reserve"]?.("o-2", 1),
    ]);
    expect(lines(log)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve call Service:inventory/PARTNER quote",
      "msg-1#1/INVENTORY.reserve result Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve#2 call Service:inventory/PARTNER quote",
      "msg-1#1/INVENTORY.reserve#2 result Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
      "msg-1#1 call Queue:q ack",
      "msg-1#1 result Queue:q ack",
    ]);
    expect(seen).toEqual([
      [
        { orderId: "o-1", qty: 2, quote: 12, keys: ["LOG", "PARTNER"] },
        { orderId: "o-2", qty: 1, quote: 12, keys: ["LOG", "PARTNER"] },
      ],
    ]);
    expect(log.entries[3]?.payload).toEqual({
      args: { args: ["o-1", 2] },
      result: { value: { orderId: "o-1", qty: 2, quote: 12, keys: ["LOG", "PARTNER"] } },
    });
    // One instance per call, as the runtime constructs one; the real binding untouched.
    expect(Inventory.constructed).toBe(2);
    expect(real.calls).toBe(0);
    expect(r.unsupportedReasons).toEqual([]);
  });

  test("what the callee throws reaches the caller as RPC carries it: the built-in class, the message, its data properties", async () => {
    const { log, seen } = await run(
      spec([inventory, partner]),
      (stub) => stub["fail"]?.("no stock") ?? Promise.resolve(),
    );
    const error = seen[0] as RangeError & { code: number };
    expect(error).toBeInstanceOf(RangeError);
    expect([error.name, error.message, error.code]).toEqual(["RangeError", "no stock", 7]);
    expect(log.entries[1]?.payload).toEqual({
      args: { args: ["no stock"] },
      result: null,
      error: "RangeError: no stock",
    });
    expect(lines(log).some((l) => l.startsWith("msg-1#1/INVENTORY.fail"))).toBe(false);
  });

  test("a fault inside the callee ends its invocation alone; the caller sees an error thrown from the call", async () => {
    const {
      log,
      seen,
      run: r,
    } = await run(
      spec([inventory, partner]),
      (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
      [
        {
          invocation: "msg-1#1/INVENTORY.reserve",
          ordinal: 0,
          fault: "crash_before",
          target: "Service:inventory/PARTNER",
          op: "quote",
        },
      ],
    );
    expect(lines(log).slice(0, 4)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve call Service:inventory/PARTNER quote",
      "msg-1#1/INVENTORY.reserve fault Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
    ]);
    const error = seen[0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("crashed while handling reserve");
    // The caller's handler threw, so the delivery errored and was redelivered: the caller was never crashed.
    expect(lines(log)).toContain("msg-1#2 result Queue:q ack");
    expect(r.unsupportedReasons).toEqual([]);
  });

  test("the call's own faults are a call's: crash_before never reaches the callee, ambiguous means it acted and the answer was lost", async () => {
    expect(callFaults).toEqual(["crash_before", "ambiguous", "crash_after"]);
    const before = await run(
      spec([inventory, partner]),
      (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
      [
        {
          invocation: "msg-1#1",
          ordinal: 0,
          fault: "crash_before",
          target: "Service:INVENTORY",
          op: "reserve",
        },
      ],
    );
    expect(before.calleeLog.calls).toEqual(["reserve o-1"]);
    expect(lines(before.log).slice(0, 2)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1 fault Service:INVENTORY reserve",
    ]);
    const lost = await run(
      spec([inventory, partner]),
      (stub) => stub["reserve"]?.("o-1", 1)?.catch(() => "lost") ?? Promise.resolve(),
      [
        {
          invocation: "msg-1#1",
          ordinal: 0,
          fault: "ambiguous",
          target: "Service:INVENTORY",
          op: "reserve",
        },
      ],
    );
    expect(lost.seen).toEqual(["lost"]);
    expect(lost.calleeLog.calls).toEqual(["reserve o-1"]);
    expect(lines(lost.log).slice(0, 5)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve call Service:inventory/PARTNER quote",
      "msg-1#1/INVENTORY.reserve result Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
      "msg-1#1 fault Service:INVENTORY reserve",
    ]);
  });

  test("the callee's waitUntil work finishes before its answer crosses, as a background point of its invocation", async () => {
    const { log, seen } = await run(spec([inventory, partner]), async (stub, calleeLog) => {
      const answer = await stub["later"]?.();
      return [answer, [...calleeLog.calls]];
    });
    expect(seen).toEqual([["answered", ["later"]]]);
    expect(lines(log)).toContain("msg-1#1/INVENTORY.later result Service:INVENTORY background");
  });

  test("an argument that is a class instance makes the run unsupported: RPC would refuse it", async () => {
    class Order {
      qty = 3;
    }
    const { run: r, seen } = await run(
      spec([inventory, partner]),
      (stub) => stub["take"]?.(new Order()).catch(() => "refused") ?? Promise.resolve(),
    );
    expect(seen).toEqual(["refused"]);
    expect(r.unsupportedReasons.join()).toContain("class instance");
  });

  test("a result that is not plain data makes the run unsupported", async () => {
    const { run: r } = await run(
      spec([inventory, partner]),
      (stub) => stub["stub"]?.() ?? Promise.resolve(),
    );
    expect(r.unsupportedReasons.join()).toContain("not plain data");
  });

  test("an awaited property is a call of its own, answered from a fresh instance", async () => {
    const { log, seen } = await run(spec([inventory, partner]), (stub) => stub.price);
    expect(seen).toEqual([42]);
    expect(log.entries[1]?.payload).toEqual({ args: { property: true }, result: { value: 42 } });
    expect(lines(log)[0]).toBe("msg-1#1 call Service:INVENTORY price");
  });

  test("a named entrypoint is the export the setup names, for methods and for fetch()", async () => {
    const named = callee("INVENTORY", {
      entry: "./inventory/worker.ts",
      config: "./inventory/wrangler.jsonc",
      entrypoint: "Other",
    });
    const { seen, run: r } = await run(spec([named]), async (stub) => [
      await stub["ping"]?.(),
      await (await stub.fetch("https://inventory.internal/x")).json(),
    ]);
    expect(seen).toEqual([["pong", { other: "/x" }]]);
    expect(r.unsupportedReasons).toEqual([]);
  });

  test("the caller's binding props reach the callee as ctx.props, by copy; the module's entrypoint applies when the setup names none", async () => {
    const { seen, run: r } = await run(
      spec([inventory, partner]),
      async (stub) => {
        const first = (await stub["whoCalled"]?.()) as { channel: string };
        first.channel = "changed";
        return [first, await stub["whoCalled"]?.()];
      },
      [],
      { INVENTORY: { name: "inventory", exports: inventoryModule, props: { channel: "lark" } } },
    );
    expect(seen).toEqual([[{ channel: "changed" }, { channel: "lark" }]]);
    expect(r.unsupportedReasons).toEqual([]);
    const named = await run(
      spec([inventory]),
      (stub) => stub["ping"]?.() ?? Promise.resolve(),
      [],
      {
        INVENTORY: { name: "inventory", exports: inventoryModule, entrypoint: "Other" },
      },
    );
    expect(named.seen).toEqual(["pong"]);
  });

  test("an instance field is not a property RPC exposes", async () => {
    const { seen } = await run(spec([inventory, partner]), (stub) =>
      Promise.resolve((stub as unknown as { field: Promise<string> }).field),
    );
    expect(seen[0]).toBeInstanceOf(TypeError);
    expect((seen[0] as Error).message).toContain('does not implement the method "field"');
  });

  test("arguments are copied at the call: a change made while the call waits for its turn does not reach the callee", async () => {
    // Two invocations in flight, so the call parks before it performs.
    const s = { ...spec([inventory, partner]), bounds: { ...bounds, maxConcurrentInvocations: 2 } };
    const { seen, run: r } = await run(s, async (stub) => {
      const order = { qty: 1 };
      const p = stub["take"]?.(order);
      order.qty = 2;
      return p;
    });
    expect(seen).toEqual([1]);
    expect(r.unsupportedReasons).toEqual([]);
  });

  test("a callee the platform was not given a module for is reported, and never the real binding", async () => {
    const { run: r, real } = await run(
      spec([inventory]),
      (stub) => stub["reserve"]?.("o-1", 1)?.catch(() => "failed") ?? Promise.resolve(),
      [],
      null,
    );
    expect(r.unsupportedReasons[0]).toContain("was not given its module");
    expect(real.calls).toBe(0);
  });
});

describe("fetch() through the binding", () => {
  test("reaches the callee's fetch handler with the request as it is; the response crosses as it is", async () => {
    const { log, seen } = await run(spec([inventory, partner]), async (stub) => {
      const r = await stub.fetch("https://inventory.internal/reserve", {
        method: "POST",
        body: "hi",
      });
      return [r.status, await r.json()];
    });
    expect(seen).toEqual([[200, { got: "hi", path: "/reserve" }]]);
    expect(lines(log).slice(0, 2)).toEqual([
      "msg-1#1 call Service:INVENTORY POST",
      "msg-1#1 result Service:INVENTORY POST",
    ]);
    expect(log.entries[1]?.payload).toMatchObject({
      args: { url: "https://inventory.internal/reserve", method: "POST", body: "hi" },
      result: { status: 200 },
    });
  });

  test("a redirect from the callee is followed by the runtime, so it is unsupported unless the fetch is manual", async () => {
    const followed = await run(spec([inventory, partner]), (stub) =>
      stub.fetch("https://inventory.internal/moved").catch(() => "failed"),
    );
    expect(followed.run.unsupportedReasons.join()).toContain(
      "302 redirect, which the runtime would follow",
    );
    const manual = await run(
      spec([inventory, partner]),
      async (stub) =>
        (await stub.fetch("https://inventory.internal/moved", { redirect: "manual" })).status,
    );
    expect(manual.seen).toEqual([302]);
    expect(manual.run.unsupportedReasons).toEqual([]);
  });

  test("a handler that throws rejects the caller's fetch() with the error, as the runtime does", async () => {
    const { seen } = await run(spec([inventory, partner]), (stub) =>
      stub.fetch("https://inventory.internal/throw"),
    );
    expect(seen[0]).toBeInstanceOf(TypeError);
    expect((seen[0] as Error).message).toBe("bad request");
  });
});

describe("a callee's own bindings", () => {
  /** A Workflow binding as env shows it; never called, the model runs the instances. */
  const fakeWorkflow = {
    create: () => {
      throw new Error("the real engine was called");
    },
    createBatch: () => {
      throw new Error("the real engine was called");
    },
    get: () => {
      throw new Error("the real engine was called");
    },
  };

  test("a nested callee runs inside the callee's call, its effects under its own invocation", async () => {
    const nested = callee("inventory/PARTNER", {
      entry: "./partner/worker.ts",
      config: "./partner/wrangler.jsonc",
    });
    const rates = service("partner/RATES", { methods: { rate: { returns: 3 } } });
    const {
      log,
      seen,
      run: r,
    } = await run(
      spec([inventory, nested, rates]),
      (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
      [],
      {
        INVENTORY: { name: "inventory", exports: inventoryModule },
        "inventory/PARTNER": { name: "partner", exports: partnerModule },
      },
      { "partner/RATES": new FakeFetcher() },
    );
    expect((seen[0] as { quote: number }).quote).toBe(9);
    expect(lines(log).slice(0, 6)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve call Service:inventory/PARTNER quote",
      "msg-1#1/INVENTORY.reserve/inventory/PARTNER.quote call Service:partner/RATES rate",
      "msg-1#1/INVENTORY.reserve/inventory/PARTNER.quote result Service:partner/RATES rate",
      "msg-1#1/INVENTORY.reserve result Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
    ]);
    expect(r.unsupportedReasons).toEqual([]);
  });

  test("a callee's binding that leads back to the scenario's own Worker runs it with the scenario's env, under its own names", async () => {
    // The storefront calls inventory, whose partner is the storefront itself: the call comes back
    // into the Worker the scenario drives, which reads its own bindings as it always does.
    class Storefront extends WorkerEntrypoint<{ RATES: { rate(): Promise<number> } }> {
      async quote(orderId: string): Promise<number> {
        return (await this.env.RATES.rate()) + orderId.length;
      }
    }
    const back = callee("inventory/PARTNER", { entry: "./worker.ts", config: "./wrangler.jsonc" });
    const rates = service("RATES", { methods: { rate: { returns: 4 } } });
    const {
      log,
      seen,
      run: r,
    } = await run(
      spec([inventory, back, rates]),
      (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
      [],
      {
        INVENTORY: { name: "inventory", exports: inventoryModule },
        "inventory/PARTNER": { name: "storefront", exports: { default: Storefront }, self: true },
      },
      { RATES: new FakeFetcher() },
    );
    expect(r.unsupportedReasons).toEqual([]);
    expect((seen[0] as { quote: number }).quote).toBe(7);
    expect(lines(log).slice(0, 6)).toEqual([
      "msg-1#1 call Service:INVENTORY reserve",
      "msg-1#1/INVENTORY.reserve call Service:inventory/PARTNER quote",
      // The scenario's own binding, not one qualified by the Worker's name.
      "msg-1#1/INVENTORY.reserve/inventory/PARTNER.quote call Service:RATES rate",
      "msg-1#1/INVENTORY.reserve/inventory/PARTNER.quote result Service:RATES rate",
      "msg-1#1/INVENTORY.reserve result Service:inventory/PARTNER quote",
      "msg-1#1 result Service:INVENTORY reserve",
    ]);
  });

  test("an alias is the binding it names: the callee's calls carry the caller's name; a setup on the alias is refused", async () => {
    const shared = service("PARTNER", { methods: { quote: { returns: 5 } } });
    const {
      log,
      seen,
      run: r,
    } = await run(
      spec([inventory, shared]),
      (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
      [],
      undefined,
      { PARTNER: new FakeFetcher() },
      { aliases: { "inventory/PARTNER": "PARTNER" } },
    );
    expect((seen[0] as { quote: number; keys: string[] }).quote).toBe(5);
    expect((seen[0] as { keys: string[] }).keys).toEqual(["LOG", "PARTNER"]);
    expect(lines(log)[1]).toBe("msg-1#1/INVENTORY.reserve call Service:PARTNER quote");
    expect(r.unsupportedReasons).toEqual([]);
    await expect(
      run(
        spec([inventory, partner]),
        (stub) => stub["reserve"]?.("o-1", 1) ?? Promise.resolve(),
        [],
        undefined,
        { PARTNER: new FakeFetcher() },
        { aliases: { "inventory/PARTNER": "PARTNER" } },
      ),
    ).rejects.toThrow("is an alias of PARTNER");
  });

  test("a callee's Workflow runs the callee's class with the callee's env", async () => {
    const shipping = callee("INVENTORY", {
      entry: "./inventory/worker.ts",
      config: "./inventory/wrangler.jsonc",
      entrypoint: "Shipping",
    });
    const flow = { kind: "workflow", binding: "inventory/FLOW", className: "Fulfilment" } as const;
    const {
      log,
      seen,
      run: r,
    } = await run(
      spec([shipping, flow]),
      async (stub, calleeLog) => [await stub["ship"]?.("w-1"), [...calleeLog.calls]],
      [],
      undefined,
      { "inventory/FLOW": fakeWorkflow },
    );
    expect(seen).toEqual([["w-1", []]]);
    expect(r.unsupportedReasons).toEqual([]);
    const l = lines(log);
    expect(l).toContain("msg-1#1/INVENTORY.ship result Workflow:inventory/FLOW create");
    expect(l.some((x) => x.includes("result Workflow:inventory/FLOW step_result"))).toBe(true);
    const snapshot = log.entries.find(
      (e) => e.kind === "snapshot" && e.target === "Workflow:inventory/FLOW",
    );
    expect(snapshot?.payload).toMatchObject({
      tables: { instances: [{ id: "w-1", status: "complete", output: "done" }] },
    });
  });
});

describe("the pieces", () => {
  test("the callee's env is a view under its own names", () => {
    const env = { DB: "caller", "inventory/DB": "callee", "inventory/KV": "kv", other: 1 };
    const view = calleeEnv("inventory", env) as Record<string, unknown>;
    expect(view["DB"]).toBe("callee");
    expect("KV" in view).toBe(true);
    expect("other" in view).toBe(false);
    expect(Object.keys(view).sort()).toEqual(["DB", "KV"]);
    expect({ ...view }).toEqual({ DB: "callee", KV: "kv" });
    // Over a raw env (a callee's Durable Object in workerd) an alias is resolved by the view itself.
    const raw = calleeEnv(
      "inventory",
      { STOCK: "ns", "inventory/DB": "callee" },
      {
        "inventory/STOCK": "STOCK",
      },
    ) as Record<string, unknown>;
    expect(raw["STOCK"]).toBe("ns");
    expect("STOCK" in raw).toBe(true);
    expect(Object.keys(raw).sort()).toEqual(["DB", "STOCK"]);
    expect(raw["OTHER"]).toBeUndefined();
  });

  test("an error crosses as a new one: name, message, data properties; nothing else", () => {
    const original = Object.assign(new Error("declined"), { name: "PaymentDeclined", code: "E1" });
    const crossed = crossingError(original) as Error & { code: string };
    expect(crossed).not.toBe(original);
    expect([crossed.name, crossed.message, crossed.code]).toEqual([
      "PaymentDeclined",
      "declined",
      "E1",
    ]);
    expect(crossingError("boom")).toMatchObject({ name: "Error", message: "boom" });
    expect(crossingError(new RangeError("r"))).toBeInstanceOf(RangeError);
  });

  test("a scenario refuses a binding both scripted and real, and a callee missing its files", () => {
    const base = {
      name: "x",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: queue("q", [{ body: 1 }]),
      invariants: [
        { kind: "unique", name: "u", query: { target: "D1:DB", table: "t" }, path: "a" },
      ],
    } as const;
    expect(() => defineScenario({ ...base, setup: [inventory, service("INVENTORY")] })).toThrow(
      "both a service() script and a callee()",
    );
    expect(() =>
      defineScenario({
        ...base,
        setup: [callee("INVENTORY", { entry: "", config: "./inventory/wrangler.jsonc" })],
      }),
    ).toThrow("needs the callee's entry");
    expect(() => defineScenario({ ...base, setup: [inventory, inventory] })).toThrow(
      "two callee() steps",
    );
  });
});
