/**
 * An object's own service bindings, in Node against a fake namespace: a call
 * an object makes through `this.env` is the scenario's, an effect of the
 * invocation the object's code runs as, answered from the service() script
 * and open to its faults. The real objects run in workerd in the corpus.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { callee, durableObject, http, service } from "./scenario.ts";

type Model = { complete(question: string): Promise<{ steps: number }>; enabled: Promise<boolean> };

/** Calls that reached the binding the runtime would hand the object: none may. */
let reachedTheRealPeer = 0;
/** A service binding as the isolate holds it: never the scenario's. */
const realPeer = () => ({
  fetch: async () => new Response("the real peer"),
  connect: () => undefined,
  complete: async () => {
    reachedTheRealPeer++;
    throw new Error("internal error; reference = abc");
  },
});

/** When set, every Runner's constructor sets a timer it does not wait for. */
let constructorTimer = false;

/** An object that asks a model service, inside a call and in work after its answer. */
class Runner {
  readonly ctx: { storage: FakeStorage };
  env: { MODEL: Model; LIMIT: number };
  constructor(storage: FakeStorage, env: object) {
    this.ctx = { storage };
    this.env = env as Runner["env"];
    // Like an object that starts work as soon as it is constructed and does not wait for it.
    if (constructorTimer) setTimeout(() => void storage.put("constructed-late", true), 10);
  }
  /** Asks inside the call and answers with what the model said. */
  async ask(question: string) {
    const { steps } = await this.env.MODEL.complete(question);
    await this.ctx.storage.put("asked", steps);
    return steps;
  }
  /** Answers at once; the question is work queued behind the answer, and a failure is the run's status. */
  async start(question: string) {
    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const { steps } = await this.env.MODEL.complete(question);
        await this.ctx.storage.put("status", `done in ${steps}`);
      } catch (err) {
        await this.ctx.storage.put("status", `failed: ${(err as Error).message}`);
      }
    })();
    return "accepted";
  }
  /** Builds its dependencies from env, as an entry point does, and calls none. */
  async idle() {
    const deps = { model: this.env.MODEL, limit: this.env.LIMIT };
    return typeof deps.model === "object" ? deps.limit : -1;
  }
  /** Reads an RPC getter of the binding. */
  async flag() {
    return await this.env.MODEL.enabled;
  }
}

/** The runtime's base class, as far as construction goes: it is found by name. */
class WorkerEntrypoint<Env = unknown> {
  readonly ctx: ExecutionContext;
  readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The model Worker for real: its own code answers, and asks a rates service of its own on the way. */
class ModelWorker extends WorkerEntrypoint<{ RATES: { rate(): Promise<number> } }> {
  async complete(question: string): Promise<{ steps: number }> {
    return { steps: question.length + (await this.env.RATES.rate()) };
  }
}

/** What happened in order, across the object and its storage: a write, a sync, the status. */
let order: string[] = [];
/** A storage whose `sync()` is the runtime's: it makes the writes before it durable. */
class GatedStorage extends FakeStorage {
  async sync(): Promise<void> {
    order.push("sync");
  }
}

function fakeNamespace(envOf: () => object) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Runner>();
  const backingOf = (id: string) => {
    let b = storages.get(id);
    if (!b) {
      b = new Backing();
      storages.set(id, b);
    }
    return b;
  };
  const instanceOf = (id: string) => {
    let i = instances.get(id);
    if (!i) {
      // The runtime constructs the object with the Worker's real env.
      i = new Runner(new GatedStorage(backingOf(id)), envOf());
      instances.set(id, i);
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
      return {
        id,
        ask: (q: string) => instanceOf(hex).ask(q),
        start: (q: string) => instanceOf(hex).start(q),
        idle: () => instanceOf(hex).idle(),
        flag: () => instanceOf(hex).flag(),
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
      // `abort()` resets the object as the runtime does: the instance goes, its storage stays.
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

type Stub = Record<"ask" | "start" | "idle" | "flag", (q: string) => Promise<unknown>>;

/** A Worker whose request calls the method its path names on the object "r". */
const handlerFor = (binding: string): WorkerHandler => ({
  async fetch(request, env) {
    const ns = (env as Record<string, { idFromName(n: string): unknown; get(id: unknown): Stub }>)[
      binding
    ];
    const method = new URL(request.url).pathname.slice(1) as keyof Stub;
    try {
      const value = await ns?.get(ns.idFromName("r"))[method]("why");
      return Response.json({ value });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
});

const scripted = service("MODEL", {
  methods: { complete: { returns: { steps: 2 } }, enabled: { returns: true } },
});

async function runOf(
  path: string,
  options: {
    faults?: Schedule["faults"];
    setup?: ScenarioSpec["setup"];
    /** The binding names, when the object is a callee's: `<name>/RUNNER`, `<name>/MODEL`. */
    callee?: string;
    /** More than one request, in order; `path` is the first when this is not given. */
    requests?: readonly string[];
    /** Callee modules given to the platform, by binding. */
    callees?: Record<string, { name: string; exports: Record<string, unknown> }>;
  } = {},
) {
  reachedTheRealPeer = 0;
  order = [];
  const q = (name: string) => (options.callee === undefined ? name : `${options.callee}/${name}`);
  const env: Record<string, unknown> = {};
  // A callee's object is constructed with the callee's view of the raw env, as the generated main does.
  const { namespace, helpers, storages } = fakeNamespace(() =>
    options.callee === undefined ? env : calleeEnv(options.callee, env),
  );
  Object.assign(env, { [q("RUNNER")]: namespace, [q("MODEL")]: realPeer(), [q("LIMIT")]: 3 });
  // A callee's own bindings are in the isolate's env under its name.
  for (const c of Object.values(options.callees ?? {})) env[`${c.name}/RATES`] = realPeer();
  const platform = createCloudflarePlatform({
    env,
    handler: handlerFor(q("RUNNER")),
    schemas: {},
    durableObjects: helpers,
    ...(options.callees === undefined ? {} : { callees: options.callees }),
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "runner",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http(
      (options.requests ?? [path]).map((p) => ({ path: p, method: "POST" })),
      { retries: 0 },
    ),
    setup: options.setup ?? [
      durableObject(q("RUNNER"), { r: {} }),
      { ...scripted, binding: q("MODEL") },
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
  return { log, run, storage: storages.get("id-r")?.data };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
/** The Worker's response, as the log records it. */
function answer(log: EffectLog): { status: number; body: unknown } {
  const record = log.entries.find((e) => e.kind === "result" && e.op === "response");
  if (!record) throw new Error("the run recorded no response");
  return (record.payload as { result: { status: number; body: unknown } }).result;
}

describe("an object's call through its own service binding", () => {
  test("inside a call it is an effect of the calling invocation, answered from the script", async () => {
    const { log, run, storage } = await runOf("/ask");
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toEqual([
      "req-1#1 call DO:RUNNER ask",
      "req-1#1 call Service:MODEL complete",
      "req-1#1 result Service:MODEL complete",
      "req-1#1 result DO:RUNNER ask",
      "req-1#1 call Http:/ask response",
      "req-1#1 result Http:/ask response",
      "platform snapshot DO:RUNNER snapshot",
    ]);
    expect(answer(log).body).toEqual({ value: 2 });
    expect(storage?.get("asked")).toBe(2);
    expect(reachedTheRealPeer).toBe(0);
  });

  test("in work after the answer it is an effect of the object's own invocation", async () => {
    const { log, run, storage } = await runOf("/start");
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toEqual([
      "req-1#1 call DO:RUNNER start",
      "req-1#1 result DO:RUNNER start",
      "req-1#1 call Http:/start response",
      "req-1#1 result Http:/start response",
      "DO:RUNNER/r/after call Service:MODEL complete",
      "DO:RUNNER/r/after result Service:MODEL complete",
      "platform snapshot DO:RUNNER snapshot",
    ]);
    expect(storage?.get("status")).toBe("done in 2");
    expect(reachedTheRealPeer).toBe(0);
  });

  test("an error placed on it is the object's to catch: the run it started ends failed, and the log says why", async () => {
    const { log, run, storage } = await runOf("/start", {
      faults: [
        {
          invocation: "DO:RUNNER/r/after",
          ordinal: 0,
          fault: "error",
          target: "Service:MODEL",
          op: "complete",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(4, 6)).toEqual([
      "DO:RUNNER/r/after call Service:MODEL complete",
      "DO:RUNNER/r/after fault Service:MODEL complete",
    ]);
    expect(String(storage?.get("status"))).toMatch(/^failed: /);
  });

  test("a crash placed on it inside a call crashes the call and resets the object", async () => {
    const { log, run, storage } = await runOf("/ask", {
      faults: [
        {
          invocation: "req-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Service:MODEL",
          op: "complete",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(0, 3)).toEqual([
      "req-1#1 call DO:RUNNER ask",
      "req-1#1 call Service:MODEL complete",
      "req-1#1 fault Service:MODEL complete",
    ]);
    expect(storage?.get("asked")).toBeUndefined();
  });

  test("the object's writes are made durable inside the call's effect, before it is performed, and not for a call that never leaves", async () => {
    const answered = await runOf("/ask");
    expect(order).toEqual(["sync"]);
    expect(answered.storage?.get("asked")).toBe(2);
    await runOf("/ask", {
      faults: [
        {
          invocation: "req-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Service:MODEL",
          op: "complete",
        },
      ],
    });
    expect(order).toEqual([]);
    // A call hosting a real callee leaves the object the same way.
    await runOf("/ask", {
      setup: [
        durableObject("RUNNER", { r: {} }),
        callee("MODEL", { entry: "./model/worker.ts", config: "./model/wrangler.jsonc" }),
        service("model/RATES", { methods: { rate: { returns: 4 } } }),
      ],
      callees: { MODEL: { name: "model", exports: { default: ModelWorker } } },
    });
    expect(order).toEqual(["sync"]);
  });

  test("an RPC getter of the binding is answered from the script too", async () => {
    const { log, run } = await runOf("/flag");
    expect(run.unsupportedReasons).toEqual([]);
    expect(answer(log).body).toEqual({ value: true });
    expect(lines(log)).toContain("req-1#1 result Service:MODEL enabled");
  });

  test("reading the binding off env without calling it is nothing, scripted or not", async () => {
    const scriptedRun = await runOf("/idle");
    expect(scriptedRun.run.unsupportedReasons).toEqual([]);
    expect(answer(scriptedRun.log).body).toEqual({ value: 3 });
    const unscripted = await runOf("/idle", { setup: [durableObject("RUNNER", { r: {} })] });
    expect(unscripted.run.unsupportedReasons).toEqual([]);
    expect(lines(unscripted.log).filter((l) => l.includes("Service:"))).toEqual([]);
  });

  test("a call on a binding the scenario does not script is UNSUPPORTED, as it is from the Worker", async () => {
    const { run } = await runOf("/ask", { setup: [durableObject("RUNNER", { r: {} })] });
    expect(run.unsupportedReasons[0]).toBe(
      "service binding MODEL needs a service() setup step scripting the Worker it reaches",
    );
    expect(reachedTheRealPeer).toBe(0);
  });

  test("a binding the scenario names a callee for hosts the callee's invocation inside the object's call", async () => {
    const { log, run, storage } = await runOf("/start", {
      setup: [
        durableObject("RUNNER", { r: {} }),
        callee("MODEL", { entry: "./model/worker.ts", config: "./model/wrangler.jsonc" }),
        service("model/RATES", { methods: { rate: { returns: 4 } } }),
      ],
      callees: { MODEL: { name: "model", exports: { default: ModelWorker } } },
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(4)).toEqual([
      "DO:RUNNER/r/after call Service:MODEL complete",
      "DO:RUNNER/r/after/MODEL.complete call Service:model/RATES rate",
      "DO:RUNNER/r/after/MODEL.complete result Service:model/RATES rate",
      "DO:RUNNER/r/after result Service:MODEL complete",
      "platform snapshot DO:RUNNER snapshot",
    ]);
    // "why" is three letters, and the callee's own scripted service gave 4.
    expect(storage?.get("status")).toBe("done in 7");
    expect(reachedTheRealPeer).toBe(0);
  });

  test("an object a crash reset in the run's last event is woken inside the run, and the snapshot reads what it kept", async () => {
    // The crash lands on the object's last call, after its answer: nothing enters the object again,
    // so only the snapshot would construct it, outside the simulation.
    const { log, run, storage } = await runOf("/start", {
      faults: [
        {
          invocation: "DO:RUNNER/r/after",
          ordinal: 0,
          fault: "crash_after",
          target: "Service:MODEL",
          op: "complete",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(4)).toEqual([
      "DO:RUNNER/r/after call Service:MODEL complete",
      "DO:RUNNER/r/after result Service:MODEL complete",
      "DO:RUNNER/r/after fault Service:MODEL complete",
      "wake:RUNNER:r:1#1 call DO:RUNNER wake",
      "wake:RUNNER:r:1#1 result DO:RUNNER wake",
      "platform snapshot DO:RUNNER snapshot",
    ]);
    // The work died with the instance before it recorded anything.
    expect(storage?.get("status")).toBeUndefined();
  });

  test("a timer the woken object's constructor sets is the object's own work where the context reaches it: it runs before the snapshot", async () => {
    // Node carries the async context into the constructor, so its timer is the object's work after
    // the wake. workerd does not, and there the run is UNSUPPORTED (the command's tests show it).
    constructorTimer = true;
    try {
      const { log, run, storage } = await runOf("/start", {
        faults: [
          {
            invocation: "DO:RUNNER/r/after",
            ordinal: 0,
            fault: "crash_after",
            target: "Service:MODEL",
            op: "complete",
          },
        ],
      });
      expect(lines(log)).toContain("wake:RUNNER:r:1#1 result DO:RUNNER wake");
      expect(storage?.get("constructed-late")).toBe(true);
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      constructorTimer = false;
    }
  });

  test("an object reset and entered again by a later event is not woken: that event constructed it", async () => {
    const { log, run } = await runOf("/ask", {
      faults: [
        {
          invocation: "req-1#1",
          ordinal: 1,
          fault: "crash_before",
          target: "Service:MODEL",
          op: "complete",
        },
      ],
      requests: ["/ask", "/idle"],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).filter((l) => l.includes(" wake"))).toEqual([]);
    expect(lines(log)).toContain("req-2#1 result DO:RUNNER idle");
  });

  test("a callee's object reads its bindings under the callee's name: PEER there is <callee>/PEER in the scenario", async () => {
    const { log, run, storage } = await runOf("/start", { callee: "runs" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(4, 6)).toEqual([
      "DO:runs/RUNNER/r/after call Service:runs/MODEL complete",
      "DO:runs/RUNNER/r/after result Service:runs/MODEL complete",
    ]);
    expect(storage?.get("status")).toBe("done in 2");
    expect(reachedTheRealPeer).toBe(0);
  });
});
