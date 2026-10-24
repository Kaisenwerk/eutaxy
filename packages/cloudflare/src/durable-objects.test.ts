/**
 * The Durable Object proxy in Node, against a fake namespace and fake test
 * helpers: what each fault at a stub call means for the object, alarms taken
 * over, and reset, seeding and snapshots. The real objects run in workerd in
 * the corpus (lease-pool-lost-response).
 */
import type { EffectLog, ScenarioSpec } from "@eutaxy/core";
import { Run, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http } from "./scenario.ts";

/** Drops a live instance of the current fake namespace, as a runtime reset does. */
let dropInstance: ((hex: string) => void) | null = null;

/** The current fake namespace, unproxied, for objects that call other objects. */
let rawNamespace: ReturnType<typeof fakeNamespace>["namespace"] | null = null;

/** When set, every Counter schedules an alarm in its constructor, before Eutaxy can take over. */
let constructorAlarms = false;
/** When set, every Counter writes to storage in its constructor. */
let constructorWrites = false;
/** When set, every Counter makes a request in its constructor. */
let constructorFetches = false;

/** When set, evicting an object fails, as when eviction is prevented. */
let evictionFails = false;

/** The object under test: counts calls and leases, and sets an alarm when asked to. */
class Counter {
  readonly ctx: { storage: FakeStorage };
  constructor(storage: FakeStorage) {
    this.ctx = { storage };
    // Like an object that schedules work as soon as it is constructed.
    if (constructorAlarms) void storage.setAlarm(Date.now() + 1000);
    if (constructorWrites) void storage.put("constructed", true);
    if (constructorFetches) void fetch("https://api.test/hello").catch(() => {});
  }
  async bump(by: number) {
    const n = ((await this.ctx.storage.get("n")) as number | undefined) ?? 0;
    await this.ctx.storage.put("n", n + by);
    return n + by;
  }
  /** Calls another object directly, as an object does through its own binding. */
  async relay() {
    await rawNamespace?.get(rawNamespace.idFromName("d")).bump(1);
    return "relayed";
  }
  /** Gets the object reset during the call, as a failing blockConcurrencyWhile does. */
  async crashSelf() {
    dropInstance?.("id-c");
    return "reset";
  }
  /** Returns an object with methods, as an RPC target would be. */
  async open() {
    return { commit: () => this.bump(1) };
  }
  async remind() {
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return "set";
  }
}

function fakeNamespace() {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Counter>();
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
      i = new Counter(new FakeStorage(backingOf(id)));
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
        bump: (by: number) => instanceOf(hex).bump(by),
        remind: () => instanceOf(hex).remind(),
        relay: () => instanceOf(hex).relay(),
        open: () => instanceOf(hex).open(),
        crashSelf: () => instanceOf(hex).crashSelf(),
        // An RPC getter: awaiting `stub.total` reads it from the object.
        get total() {
          return instanceOf(hex).ctx.storage.get("n");
        },
      };
    },
  };
  rawNamespace = namespace;
  dropInstance = (hex) => instances.delete(hex);
  const helpers = {
    runInDurableObject: async (
      stub: { id: { toString(): string } },
      callback: (instance: unknown, state: { storage: FakeStorage }) => unknown,
    ) => {
      const instance = instanceOf(stub.id.toString());
      return callback(instance, { storage: instance.ctx.storage });
    },
    evictDurableObject: async (stub: { id: { toString(): string } }) => {
      if (evictionFails) throw new Error("eviction prevented");
      // Like the real helper: only a running object can be evicted.
      if (!instances.delete(stub.id.toString())) throw new Error("not running");
    },
    listDurableObjectIds: async () => [...storages.keys()].map(idFor),
  };
  return { namespace, helpers, storages };
}

/** A Worker whose request bumps the counter object named "c" and answers with the new value. */
const handler: WorkerHandler = {
  async fetch(request, env) {
    const ns = (
      env as {
        COUNTER: {
          idFromName(n: string): unknown;
          idFromString(hex: string): unknown;
          get(id: unknown): Counter;
        };
      }
    ).COUNTER;
    const path = new URL(request.url).pathname;
    // "/other" uses an object the scenario does not seed.
    const stub = ns.get(
      path === "/other-by-id"
        ? ns.idFromString("id-e")
        : ns.idFromName(path === "/other" ? "e" : "c"),
    );
    try {
      const value =
        path === "/remind"
          ? await stub.remind()
          : path === "/relay"
            ? await stub.relay()
            : path === "/crash-self"
              ? await stub.crashSelf()
              : path === "/pipelined-property"
                ? await (stub as unknown as { total: { value: Promise<number> } }).total.value
                : path === "/pipelined"
                  ? await (stub.bump(2) as unknown as { value: Promise<number> }).value
                  : path === "/open"
                    ? ((await stub.open()) as unknown as string)
                    : path === "/total"
                      ? await (stub as unknown as { total: Promise<number> }).total
                      : await stub.bump(2);
      return Response.json({ value });
    } catch {
      return new Response("object unavailable", { status: 503 });
    }
  },
};

function spec(path = "/bump"): ScenarioSpec {
  return {
    version: 1,
    name: "counter",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path, method: "POST" }], { retries: 0 }),
    setup: [durableObject("COUNTER", { c: { n: 40 } })],
    externals: [],
    invariants: [],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 0,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };
}

async function runWith(
  fault: "crash_before" | "error" | "ambiguous" | "crash_after" | null,
  options: { path?: string; withHelpers?: boolean } = {},
): Promise<{ log: EffectLog; run: Run; storages: Map<string, Backing> }> {
  const { namespace, helpers, storages } = fakeNamespace();
  const platform = createCloudflarePlatform({
    env: { COUNTER: namespace },
    handler,
    schemas: {},
    ...(options.withHelpers === false ? {} : { durableObjects: helpers }),
  });
  const s = spec(options.path);
  const op =
    options.path === "/remind"
      ? "remind"
      : options.path === "/relay"
        ? "relay"
        : options.path === "/open"
          ? "open"
          : "bump";
  const run = new Run({
    mode: "replay",
    schedule: {
      seed: 1,
      faults: fault ? [{ invocation: "req-1#1", ordinal: 0, fault, target: "DO:COUNTER", op }] : [],
    },
    bounds: s.bounds,
    faultProbability: 0,
  });
  if (options.withHelpers === false) {
    // Without helpers there is no setup to apply: drop it so reset does not demand them.
    const log = await runOnce({ ...s, setup: [] }, platform, run);
    return { log, run, storages };
  }
  const log = await runOnce(s, platform, run);
  return { log, run, storages };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
const response = (log: EffectLog) =>
  log.entries.find((e) => e.kind === "result" && e.op === "response")?.payload as {
    result: { status: number; body: unknown };
  };
const stored = (storages: Map<string, Backing>) => storages.get("id-c")?.data.get("n");

describe("Durable Object stub calls", () => {
  test("a call is one effect naming the object and its arguments, and the snapshot shows storage", async () => {
    const { log, run } = await runWith(null);
    expect(run.unsupportedReasons).toEqual([]);
    expect(log.entries[0]?.payload).toEqual({ args: { object: "c", args: [2] } });
    expect(log.entries[1]?.payload).toMatchObject({ result: 42 });
    expect(response(log).result.body).toEqual({ value: 42 });
    const snapshot = log.entries.find((e) => e.kind === "snapshot" && e.target === "DO:COUNTER");
    expect(snapshot?.payload).toEqual({ tables: { c: [{ key: "n", value: 42 }] } });
  });

  test("crash_before and error: the call never reaches the object", async () => {
    for (const fault of ["crash_before", "error"] as const) {
      const { storages } = await runWith(fault);
      expect(stored(storages)).toBe(40);
    }
  });

  test("ambiguous: the object committed, the caller lost the answer", async () => {
    const { log, storages } = await runWith("ambiguous");
    expect(stored(storages)).toBe(42);
    expect(lines(log).slice(0, 3)).toEqual([
      "req-1#1 call DO:COUNTER bump",
      "req-1#1 result DO:COUNTER bump",
      "req-1#1 fault DO:COUNTER bump",
    ]);
    expect(response(log).result.status).toBe(503);
  });

  test("crash_after: the object committed and the caller died after the call", async () => {
    const { log, storages } = await runWith("crash_after");
    expect(stored(storages)).toBe(42);
    expect(lines(log)).not.toContain("req-1#1 result Http:/bump response");
  });

  test("an alarm is taken over and never set on the object; one without alarm() is UNSUPPORTED", async () => {
    const { run, storages } = await runWith(null, { path: "/remind" });
    expect(storages.get("id-c")?.realAlarmSets).toBe(0);
    expect(run.unsupportedReasons.join()).toContain("has no alarm() handler");
  });

  test("without the test helpers a call makes the run UNSUPPORTED", async () => {
    const { run } = await runWith(null, { withHelpers: false });
    expect(run.unsupportedReasons.join()).toContain("needs the Cloudflare test helpers");
  });

  test("each run starts from the seeded storage, whatever the previous run left", async () => {
    const { namespace, helpers, storages } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    const s = spec();
    for (let i = 0; i < 2; i++) {
      const run = new Run({
        mode: "replay",
        schedule: { seed: 1, faults: [] },
        bounds: s.bounds,
        faultProbability: 0,
      });
      await runOnce(s, platform, run);
      expect(stored(storages)).toBe(42);
    }
  });

  test("an alarm set in the constructor, before the takeover, moves off the runtime and is adopted", async () => {
    constructorAlarms = true;
    try {
      const { run, storages } = await runWith(null);
      expect(storages.get("id-c")?.realAlarm).toBeNull();
      // Adopted, it fires; this object has no alarm() handler.
      expect(run.unsupportedReasons.join()).toContain("has no alarm() handler");
    } finally {
      constructorAlarms = false;
    }
  });

  test("a namespace with no durableObject setup is not reset between runs, so using it is UNSUPPORTED", async () => {
    const { namespace, helpers } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    const s = { ...spec(), setup: [] };
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: s.bounds,
      faultProbability: 0,
    });
    await runOnce(s, platform, run);
    expect(run.unsupportedReasons.join()).toContain("COUNTER has no durableObject setup");
  });

  test("an object the run never reached is snapshotted from its seed, without constructing it", async () => {
    constructorWrites = true;
    try {
      const { log } = await runWith("crash_before");
      const snapshot = log.entries.find((e) => e.kind === "snapshot" && e.target === "DO:COUNTER");
      expect(snapshot?.payload).toEqual({ tables: { c: [{ key: "n", value: 40 }] } });
    } finally {
      constructorWrites = false;
    }
  });

  test("an eviction that fails fails the reset instead of keeping the old instance", async () => {
    evictionFails = true;
    try {
      await expect(runWith(null)).rejects.toThrow("eviction prevented");
    } finally {
      evictionFails = false;
    }
  });

  test("a jurisdiction-scoped namespace makes the run UNSUPPORTED", async () => {
    const { namespace, helpers } = fakeNamespace();
    const viaJurisdiction: WorkerHandler = {
      async fetch(_request, env) {
        const ns = (env as { COUNTER: { jurisdiction(j: string): typeof namespace } }).COUNTER;
        ns.jurisdiction("eu");
        return new Response("ok");
      },
    };
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler: viaJurisdiction,
      schemas: {},
      durableObjects: helpers,
    });
    const s = spec();
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: s.bounds,
      faultProbability: 0,
    });
    await runOnce(s, platform, run);
    expect(run.unsupportedReasons.join()).toContain("jurisdiction");
  });

  test("an object reached only through another object makes the run UNSUPPORTED", async () => {
    const { run } = await runWith(null, { path: "/relay" });
    expect(run.unsupportedReasons.join()).toContain("COUNTER id-d was reached without a call");
  });

  test("a snapshot lists only seeded objects and the ones this run reached, whatever earlier runs did", async () => {
    const { namespace, helpers } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    const s = spec("/other");
    const snapshotOf = async (faults: Run["options"]["schedule"]["faults"]) => {
      const run = new Run({
        mode: "replay",
        schedule: { seed: 1, faults },
        bounds: s.bounds,
        faultProbability: 0,
      });
      const log = await runOnce(s, platform, run);
      return log.entries.find((e) => e.kind === "snapshot" && e.target === "DO:COUNTER")?.payload;
    };
    const neverReached = [
      {
        invocation: "req-1#1",
        ordinal: 0,
        fault: "crash_before" as const,
        target: "DO:COUNTER",
        op: "bump",
      },
    ];
    const fresh = await snapshotOf(neverReached);
    await snapshotOf([]); // creates and fills "e"
    expect(await snapshotOf(neverReached)).toEqual(fresh);
    expect(fresh).toEqual({ tables: { c: [{ key: "n", value: 40 }] } });
  });

  test("an object's name in the log comes from this run, not from names earlier runs learned", async () => {
    const { namespace, helpers } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    const objectIn = async (path: string) => {
      const s = spec(path);
      const run = new Run({
        mode: "replay",
        schedule: { seed: 1, faults: [] },
        bounds: s.bounds,
        faultProbability: 0,
      });
      const log = await runOnce(s, platform, run);
      return (log.entries[0]?.payload as { args?: { object?: string } } | undefined)?.args?.object;
    };
    await objectIn("/other"); // learns that id-e is named "e"
    expect(await objectIn("/other-by-id")).toBe("id-e");
  });

  test("awaiting an RPC property reads it from the object as one effect", async () => {
    const { log, run } = await runWith(null, { path: "/total" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(log.entries[0]?.payload).toEqual({ args: { object: "c", property: true } });
    expect(response(log).result.body).toEqual({ value: 40 });
  });

  test("a constructor that makes a request during reset fails the reset loudly", async () => {
    constructorFetches = true;
    try {
      await expect(runWith(null)).rejects.toThrow(/constructor made a request during reset/);
    } finally {
      constructorFetches = false;
    }
  });

  test("a method that returns an RPC capability makes the run UNSUPPORTED", async () => {
    const { run } = await runWith(null, { path: "/open" });
    expect(run.unsupportedReasons.join()).toContain("returned something that is not plain data");
  });

  test("pipelining through an RPC property makes the run UNSUPPORTED too", async () => {
    const { run } = await runWith(null, { path: "/pipelined-property" });
    expect(run.unsupportedReasons.join()).toContain("promise pipelining");
  });

  test("RPC promise pipelining makes the run UNSUPPORTED instead of reading undefined", async () => {
    const { run } = await runWith(null, { path: "/pipelined" });
    expect(run.unsupportedReasons.join()).toContain("promise pipelining");
  });

  test("an object reset during its call is not silently reconstructed for the snapshot", async () => {
    const { run } = await runWith(null, { path: "/crash-self" });
    expect(run.unsupportedReasons.join()).toContain("reconstructed for the snapshot");
  });
});

describe("snapshot tables", () => {
  test("an object named __proto__ gets its own table", async () => {
    const { namespace, helpers } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    // JSON.parse makes "__proto__" an own key, as a seed read from a file would.
    const seed = JSON.parse('{"__proto__": {"n": 1}, "c": {"n": 40}}');
    const s = { ...spec(), setup: [durableObject("COUNTER", seed)] };
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: s.bounds,
      faultProbability: 0,
    });
    const log = await runOnce(s, platform, run);
    const snapshot = log.entries.find((e) => e.kind === "snapshot" && e.target === "DO:COUNTER");
    const tables = (snapshot?.payload as { tables?: object } | undefined)?.tables ?? {};
    expect(Object.getOwnPropertyDescriptor(tables, "__proto__")?.value).toEqual([
      { key: "n", value: 1 },
    ]);
  });
});

describe("seeds by name", () => {
  test("an object seeded under the empty name does not seed objects whose name is unknown", async () => {
    const { namespace, helpers, storages } = fakeNamespace();
    const platform = createCloudflarePlatform({
      env: { COUNTER: namespace },
      handler,
      schemas: {},
      durableObjects: helpers,
    });
    const runOf = async (path: string) => {
      const s = {
        ...spec(path),
        setup: [durableObject("COUNTER", { "": { n: 5 }, c: { n: 40 } })],
      };
      const run = new Run({
        mode: "replay",
        schedule: { seed: 1, faults: [] },
        bounds: s.bounds,
        faultProbability: 0,
      });
      await runOnce(s, platform, run);
    };
    await runOf("/other"); // creates "e", whose name a later run does not learn
    await runOf("/bump");
    expect(storages.get("id-e")?.data.get("n")).toBeUndefined();
  });
});

describe("isPlainData", () => {
  test("accepts data, rejects methods and anything too deep to inspect", async () => {
    const { isPlainData } = await import("./durable-objects.ts");
    expect(isPlainData({ a: [1, "x", null, { b: true }] })).toBe(true);
    expect(isPlainData({ commit() {} })).toBe(false);
    let deep: unknown = { capability: () => 1 };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(isPlainData(deep)).toBe(false);
  });
});
