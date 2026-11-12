/**
 * An object's remaining bindings, in Node against a fake namespace: a
 * Workflow binding on `this.env` is the model's, as the Worker's is, so an
 * instance an object creates runs the scenario's class as an event of the
 * run and never in the local engine; and a call on a binding the model does
 * not cover is refused from inside an object as it is from the Worker.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { lastSnapshot } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http, workflow } from "./scenario.ts";

/** What the object's storage did, in order. */
let order: string[] = [];
/** Calls that reached the isolate's own bindings: none may. */
let reached: string[] = [];

/** workerd's base refuses to be constructed outside the runtime; this one refuses always. */
class WorkflowEntrypoint {
  constructor() {
    throw new TypeError("Failed to construct 'WorkflowEntrypoint'");
  }
}

type Step = {
  do(name: string, callback: () => Promise<unknown>): Promise<unknown>;
  waitForEvent(name: string, options: unknown): Promise<unknown>;
};

/** Packs an order, then waits to be told to send it. */
class Fulfil extends WorkflowEntrypoint {
  async run(event: { payload: { name: string } }, step: Step) {
    const packed = await step.do("pack", async () => `packed ${event.payload.name}`);
    try {
      await step.waitForEvent("go", { type: "go", timeout: "1 hour" });
    } catch {
      return { packed, sent: false };
    }
    return { packed, sent: true };
  }
}

type Handle = {
  id: string;
  status(): Promise<{ status: string }>;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
};
type Flow = { create(options: unknown): Promise<Handle>; get(id: string): Promise<Handle> };

/** The isolate's own Workflow binding: the local engine, which must never be asked. */
const realFlow = () => ({
  create: async () => void reached.push("create"),
  createBatch: async () => void reached.push("createBatch"),
  get: async () => void reached.push("get"),
});

/** A binding of a kind the model does not cover. */
const realCache = () => ({
  get: async () => {
    reached.push("cache get");
    return "cached";
  },
  put: async () => void reached.push("cache put"),
});

/** A storage whose `sync()` is the runtime's: it makes the writes before it durable. */
class GatedStorage extends FakeStorage {
  override async put(key: string | Record<string, unknown>, value?: unknown) {
    order.push(`storage ${String(key)}`);
    return super.put(key, value);
  }
  async sync(): Promise<void> {
    order.push("sync");
  }
}

/** An object that starts a Workflow instance for each order it takes. */
class Orders {
  readonly ctx: { storage: FakeStorage };
  env: { FLOW: Flow; CACHE: { get(key: string): Promise<string> }; LIMIT: number };
  constructor(storage: FakeStorage, env: object) {
    this.ctx = { storage };
    this.env = env as Orders["env"];
  }
  /** Inside the call: the claim in its own storage, then the instance, then the mark that it started. */
  async place(name: string) {
    await this.ctx.storage.put("claimed", name);
    const instance = await this.env.FLOW.create({ id: name, params: { name } });
    await this.ctx.storage.put("started", instance.id);
    return instance.id;
  }
  /** Answers at once; the instance is created in work queued behind the answer. */
  async later(name: string) {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await this.env.FLOW.create({ id: name, params: { name } });
    })().catch(() => {});
    return "accepted";
  }
  /** Tells the instance to go on, through the handle the binding gave. */
  async nudge(name: string) {
    const instance = await this.env.FLOW.get(name);
    await this.ctx.storage.put("nudged", name);
    await instance.sendEvent({ type: "go", payload: 1 });
    return typeof (await instance.status()).status;
  }
  async cached(name: string) {
    return this.env.CACHE.get(name);
  }
  /** Builds its dependencies from env and calls nothing. */
  async idle() {
    const deps = { flow: this.env.FLOW, cache: this.env.CACHE };
    return typeof deps.flow === "object" && typeof deps.cache === "object" ? this.env.LIMIT : -1;
  }
}

type Method = "place" | "later" | "nudge" | "cached" | "idle";

function fakeNamespace(envOf: () => object) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Orders>();
  const instanceOf = (hex: string) => {
    let i = instances.get(hex);
    if (!i) {
      let backing = storages.get(hex);
      if (!backing) {
        backing = new Backing();
        storages.set(hex, backing);
      }
      // The runtime constructs the object with the Worker's real env.
      i = new Orders(new GatedStorage(backing), envOf());
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
      const call = (method: Method) => (n: string) => instanceOf(hex)[method](n);
      return {
        id,
        place: call("place"),
        later: call("later"),
        nudge: call("nudge"),
        cached: call("cached"),
        idle: call("idle"),
      };
    },
  };
  const helpers = {
    runInDurableObject: async (
      stub: { id: { toString(): string } },
      callback: (instance: unknown, state: { storage: FakeStorage; abort: () => void }) => unknown,
    ) => {
      const hex = stub.id.toString();
      const instance = instanceOf(hex);
      return callback(instance, {
        storage: instance.ctx.storage,
        abort: () => void instances.delete(hex),
      });
    },
    evictDurableObject: async (stub: { id: { toString(): string } }) => {
      if (!instances.delete(stub.id.toString())) throw new Error("not running");
    },
    listDurableObjectIds: async () => [...storages.keys()].map(idFor),
  };
  return { namespace, helpers, storages };
}

type Stub = Record<Method, (n: string) => Promise<unknown>>;

/** A Worker whose request calls the method its path names on the object "o", for the order "a". */
const handlerFor = (binding: string): WorkerHandler => ({
  async fetch(request, env) {
    const ns = (env as Record<string, { idFromName(n: string): unknown; get(id: unknown): Stub }>)[
      binding
    ];
    const method = new URL(request.url).pathname.slice(1) as Method;
    try {
      return Response.json({ value: await ns?.get(ns.idFromName("o"))[method]("a") });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
});

async function runOf(
  paths: readonly string[],
  options: {
    faults?: Schedule["faults"];
    /** The binding names, when the object is a callee's: `<name>/ORDERS`, `<name>/FLOW`. */
    callee?: string;
    /** Leave the Workflow out of the setup. */
    noFlowStep?: boolean;
  } = {},
) {
  order = [];
  reached = [];
  const q = (name: string) => (options.callee === undefined ? name : `${options.callee}/${name}`);
  const env: Record<string, unknown> = {};
  const { namespace, helpers, storages } = fakeNamespace(() =>
    options.callee === undefined ? env : calleeEnv(options.callee, env),
  );
  Object.assign(env, {
    [q("ORDERS")]: namespace,
    [q("FLOW")]: realFlow(),
    [q("CACHE")]: realCache(),
    [q("LIMIT")]: 3,
  });
  const platform = createCloudflarePlatform({
    env,
    handler: handlerFor(q("ORDERS")),
    schemas: {},
    durableObjects: helpers,
    exports: { Fulfil },
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "orders",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http(
      paths.map((path) => ({ path, method: "POST" })),
      { retries: 0 },
    ),
    setup: [
      durableObject(q("ORDERS"), { o: {} }),
      ...(options.noFlowStep ? [] : [workflow(q("FLOW"), "Fulfil")]),
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
  const instances = (lastSnapshot(log as never, `Workflow:${q("FLOW")}`)?.["instances"] ??
    []) as unknown as { id: string; status: string; output?: unknown }[];
  return { log, run, instances, storage: storages.get("id-o")?.data };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

describe("an object's Workflow binding", () => {
  test("an instance it creates inside a call is an effect of the calling invocation, and runs the scenario's class in the model", async () => {
    const { log, run, instances, storage } = await runOf(["/place"]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(reached).toEqual([]);
    expect(lines(log).slice(0, 4)).toEqual([
      "req-1#1 call DO:ORDERS place",
      "req-1#1 call Workflow:FLOW create",
      "req-1#1 result Workflow:FLOW create",
      "req-1#1 result DO:ORDERS place",
    ]);
    expect(lines(log)).toContain("workflow:FLOW:a#1 result Workflow:FLOW step_result");
    // Nobody sent the event: the wait timed out in virtual time.
    expect(instances).toEqual([
      {
        id: "a",
        status: "complete",
        params: { name: "a" },
        output: { packed: "packed a", sent: false },
      },
    ]);
    expect(storage?.get("started")).toBe("a");
  });

  test("the call leaves the object once the writes before it are durable, and a crash after it finds them kept", async () => {
    await runOf(["/place"]);
    expect(order).toEqual(["storage claimed", "sync", "storage started"]);
    // The instance is created and the object dies before it marks it: the claim stayed.
    const crashed = await runOf(["/place"], {
      faults: [
        {
          invocation: "req-1#1",
          ordinal: 1,
          fault: "crash_after",
          target: "Workflow:FLOW",
          op: "create",
        },
      ],
    });
    expect(crashed.run.unsupportedReasons).toEqual([]);
    expect(lines(crashed.log)).toContain("req-1#1 fault Workflow:FLOW create");
    expect(crashed.instances.map((i) => i.id)).toEqual(["a"]);
    expect(crashed.storage?.get("claimed")).toBe("a");
    expect(crashed.storage?.get("started")).toBeUndefined();
  });

  test("a create that never reached the engine leaves no instance", async () => {
    const { log, run, instances } = await runOf(["/place"], {
      faults: [
        {
          invocation: "req-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Workflow:FLOW",
          op: "create",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 fault Workflow:FLOW create");
    expect(instances).toEqual([]);
    expect(reached).toEqual([]);
  });

  test("work after the answer creates it as the object's own invocation", async () => {
    const { log, run, instances } = await runOf(["/later"]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("DO:ORDERS/o/after call Workflow:FLOW create");
    expect(lines(log).indexOf("DO:ORDERS/o/after call Workflow:FLOW create")).toBeGreaterThan(
      lines(log).indexOf("req-1#1 result DO:ORDERS later"),
    );
    expect(instances.map((i) => i.id)).toEqual(["a"]);
  });

  test("a call on the handle the binding gave is the object's call too, behind its gate", async () => {
    const { log, run, instances } = await runOf(["/place", "/nudge"]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(reached).toEqual([]);
    expect(
      lines(log)
        .filter((l) => l.startsWith("req-2#1 "))
        .slice(0, 8),
    ).toEqual([
      "req-2#1 call DO:ORDERS nudge",
      "req-2#1 call Workflow:FLOW get",
      "req-2#1 result Workflow:FLOW get",
      "req-2#1 call Workflow:FLOW send_event",
      "req-2#1 result Workflow:FLOW send_event",
      "req-2#1 call Workflow:FLOW status",
      "req-2#1 result Workflow:FLOW status",
      "req-2#1 result DO:ORDERS nudge",
    ]);
    // The write before the event is durable before the event leaves.
    const nudged = order.indexOf("storage nudged");
    expect(order[nudged + 1]).toBe("sync");
    // create, get, sendEvent and status each waited on the gate.
    expect(order.filter((o) => o === "sync")).toHaveLength(4);
    expect(instances).toEqual([
      {
        id: "a",
        status: "complete",
        params: { name: "a" },
        output: { packed: "packed a", sent: true },
      },
    ]);
  });

  test("a callee's object creates it under the callee's name", async () => {
    const { log, run, instances } = await runOf(["/place"], { callee: "shop" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(reached).toEqual([]);
    expect(lines(log).slice(0, 3)).toEqual([
      "req-1#1 call DO:shop/ORDERS place",
      "req-1#1 call Workflow:shop/FLOW create",
      "req-1#1 result Workflow:shop/FLOW create",
    ]);
    expect(instances.map((i) => i.id)).toEqual(["a"]);
  });

  test("without a workflow() step the run is UNSUPPORTED once the object uses it, and the local engine is not asked", async () => {
    const used = await runOf(["/place"], { noFlowStep: true });
    expect(used.run.unsupportedReasons).toEqual([
      "Workflow binding FLOW needs a workflow() setup step naming its class",
    ]);
    expect(reached).toEqual([]);
    // Reading it off env binds nothing.
    const idle = await runOf(["/idle"], { noFlowStep: true });
    expect(idle.run.unsupportedReasons).toEqual([]);
    expect(lines(idle.log).slice(0, 2)).toEqual([
      "req-1#1 call DO:ORDERS idle",
      "req-1#1 result DO:ORDERS idle",
    ]);
  });
});

describe("an object's binding of a kind the model does not cover", () => {
  test("a call on it is refused as it is from the Worker, and never reaches the binding", async () => {
    const { run } = await runOf(["/cached"]);
    expect(run.unsupportedReasons).toEqual(["binding CACHE is not proxied"]);
    expect(reached).toEqual([]);
  });

  test("a callee's object's is refused under the callee's name", async () => {
    const { run } = await runOf(["/cached"], { callee: "shop" });
    expect(run.unsupportedReasons).toEqual(["binding shop/CACHE is not proxied"]);
    expect(reached).toEqual([]);
  });

  test("reading it off env does nothing", async () => {
    const { run } = await runOf(["/idle"]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(reached).toEqual([]);
  });
});
