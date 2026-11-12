/**
 * An object's env from its construction, in Node against a stand-in for the
 * runtime's `DurableObject`: a class among the platform's exports is given a
 * base that hands its constructor the scenario's view of env, so a call the
 * constructor makes through a service binding is answered by the script.
 */
import type { EffectLog, ScenarioSpec } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http, service } from "./scenario.ts";

/** The runtime's base class, as far as construction goes: it is found by name. */
class DurableObject<Env = unknown> {
  readonly ctx: { storage: FakeStorage; id: { toString(): string } };
  readonly env: Env;
  constructor(ctx: DurableObject["ctx"], env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

type Config = { load(): Promise<{ limit: number }> };

/** Calls that reached the binding the runtime would hand the object: none may. */
let reachedTheRealPeer = 0;
const realPeer = () => ({
  fetch: async () => new Response("the real peer"),
  connect: () => undefined,
  load: async () => {
    reachedTheRealPeer++;
    return { limit: -1 };
  },
});

/**
 * An object that loads its configuration from another Worker as it is constructed. A class of its
 * own per run: the base the platform gives a class stays on it.
 */
const makeLoader = () =>
  class Loader extends DurableObject<{ CONFIG: Config }> {
    limit = 0;
    readonly loaded: Promise<void>;
    constructor(ctx: DurableObject["ctx"], env: { CONFIG: Config }) {
      super(ctx, env);
      this.loaded = this.env.CONFIG.load().then(
        (config) => {
          this.limit = config.limit;
        },
        // Constructed outside a run too (the reset), where a call the scenario does not script is refused.
        () => {},
      );
    }
    async read(): Promise<number> {
      await this.loaded;
      return this.limit;
    }
  };
type LoaderClass = ReturnType<typeof makeLoader>;
type Loader = InstanceType<LoaderClass>;

function fakeNamespace(cls: LoaderClass, env: object) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Loader>();
  const idFor = (hex: string) => ({ toString: () => hex, equals: () => false });
  const instanceOf = (hex: string) => {
    let i = instances.get(hex);
    if (!i) {
      let backing = storages.get(hex);
      if (!backing) {
        backing = new Backing();
        storages.set(hex, backing);
      }
      // As the runtime constructs it: its state, and the Worker's real env.
      i = new cls({ storage: new FakeStorage(backing), id: idFor(hex) }, env as { CONFIG: Config });
      instances.set(hex, i);
    }
    return i;
  };
  const namespace = {
    idFromName: (name: string) => idFor(`id-${name}`),
    idFromString: (hex: string) => idFor(hex),
    jurisdiction: () => namespace,
    newUniqueId: () => idFor("id-random"),
    get: (id: { toString(): string }) => ({ id, read: () => instanceOf(id.toString()).read() }),
  };
  const helpers = {
    runInDurableObject: async (
      stub: { id: { toString(): string } },
      callback: (instance: unknown, state: object) => unknown,
    ) => {
      const instance = instanceOf(stub.id.toString());
      return callback(instance, instance.ctx);
    },
    evictDurableObject: async (stub: { id: { toString(): string } }) => {
      if (!instances.delete(stub.id.toString())) throw new Error("not running");
    },
    listDurableObjectIds: async () => [...storages.keys()].map(idFor),
  };
  return { namespace, helpers };
}

const handler: WorkerHandler = {
  async fetch(_request, env) {
    const ns = (
      env as {
        LOADER: { idFromName(n: string): unknown; get(id: unknown): { read(): Promise<number> } };
      }
    ).LOADER;
    return Response.json({ limit: await ns.get(ns.idFromName("l")).read() });
  },
};

/** What `runWith` last built, to construct the same class again outside any run. */
let lastBuilt: { cls: LoaderClass; env: object } | undefined;

async function runWith(exports: Record<string, unknown> | undefined) {
  reachedTheRealPeer = 0;
  const cls = makeLoader();
  const env: Record<string, unknown> = { CONFIG: realPeer() };
  const { namespace, helpers } = fakeNamespace(cls, env);
  env["LOADER"] = namespace;
  lastBuilt = { cls, env };
  const platform = createCloudflarePlatform({
    env,
    handler,
    schemas: {},
    durableObjects: helpers,
    ...(exports === undefined ? {} : { exports: { ...exports, Loader: cls } }),
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "loader",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path: "/", method: "GET" }], { retries: 0 }),
    setup: [
      durableObject("LOADER", { l: {} }),
      service("CONFIG", { methods: { load: { returns: { limit: 7 } } } }),
    ],
    externals: [],
    invariants: [],
    bounds: {
      maxFaultsPerRun: 0,
      maxRedeliveries: 0,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };
  const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: s.bounds });
  const log = await runOnce(s, platform, run);
  return { log, run };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
const limit = (log: EffectLog) =>
  (
    log.entries.find((e) => e.kind === "result" && e.op === "response")?.payload as
      | { result: { body: { limit: number } } }
      | undefined
  )?.result.body.limit;

describe("an object's env from its construction", () => {
  test("a class among the platform's exports is constructed with the scenario's view: its constructor's call is the script's", async () => {
    const { log, run } = await runWith({});
    expect(run.unsupportedReasons).toEqual([]);
    expect(limit(log)).toBe(7);
    expect(reachedTheRealPeer).toBe(0);
    // The call is made while the first call into the object constructs it: that call's effect.
    expect(lines(log).slice(0, 4)).toEqual([
      "req-1#1 call DO:LOADER read",
      "req-1#1 call Service:CONFIG load",
      "req-1#1 result Service:CONFIG load",
      "req-1#1 result DO:LOADER read",
    ]);
  });

  test("outside the platform's runs the class is constructed with the runtime's env, as a comparison against the real bindings needs", async () => {
    await runWith({});
    if (!lastBuilt) throw new Error("nothing built");
    // What the differential runner's raw side does after a simulated run: the same class, the same
    // object id, no platform. The base the class was given must hand the env on untouched.
    reachedTheRealPeer = 0;
    const raw = new lastBuilt.cls(
      { storage: new FakeStorage(new Backing()), id: { toString: () => "id-l" } },
      lastBuilt.env as { CONFIG: Config },
    );
    expect(await raw.read()).toBe(-1);
    expect(reachedTheRealPeer).toBe(1);
  });

  test("a class the platform was not given is constructed with the runtime's env: its constructor's call is not seen", async () => {
    const { log, run } = await runWith(undefined);
    // The limit the design states: the view is in place once the constructor has returned.
    expect(limit(log)).toBe(-1);
    expect(reachedTheRealPeer).toBeGreaterThan(0);
    expect(run.unsupportedReasons).toEqual([]);
  });
});
