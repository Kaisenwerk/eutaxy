/**
 * An object whose `blockConcurrencyWhile` callback fails, in Node against a
 * stand-in for the runtime: the runtime resets such an object, so the model
 * does too. Its instance is gone with whatever it had running, and when
 * nothing enters it again it is woken inside the run, as any object a
 * crash reset is.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http, service } from "./scenario.ts";

/** The object's state as the runtime gives it: a failed callback behind the gate resets the object. */
class State {
  readonly storage: FakeStorage;
  readonly id: { toString(): string };
  readonly broken: () => void;
  constructor(storage: FakeStorage, id: { toString(): string }, broken: () => void) {
    this.storage = storage;
    this.id = id;
    this.broken = broken;
  }
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const held = callback();
    held.catch(() => this.broken());
    return held;
  }
}

/** The runtime's base class, as far as construction goes: it is found by name. */
class DurableObject<Env = unknown> {
  readonly ctx: State;
  readonly env: Env;
  constructor(ctx: State, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

type Config = { load(): Promise<{ limit: number }> };

/** An object that loads its configuration behind its input gate as it is constructed. */
const makeGated = () =>
  class Gated extends DurableObject<{ CONFIG: Config }> {
    limit = 0;
    readonly ready: Promise<void>;
    constructor(ctx: State, env: { CONFIG: Config }) {
      super(ctx, env);
      this.ready = this.ctx.blockConcurrencyWhile(async () => {
        this.limit = (await this.env.CONFIG.load()).limit;
      });
      // Constructed outside a run too (the reset), where the failure is nobody's to see.
      this.ready.catch(() => {});
    }
    /** The call is let in once the gate opens, and fails when the gate broke. */
    async read(): Promise<number> {
      await this.ready;
      return this.limit;
    }
  };
type GatedClass = ReturnType<typeof makeGated>;

function fakeNamespace(cls: GatedClass, env: object) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, InstanceType<GatedClass>>();
  const idFor = (hex: string) => ({ toString: () => hex, equals: () => false });
  const instanceOf = (hex: string) => {
    let i = instances.get(hex);
    if (!i) {
      let backing = storages.get(hex);
      if (!backing) {
        backing = new Backing();
        storages.set(hex, backing);
      }
      const state = new State(new FakeStorage(backing), idFor(hex), () => {
        if (instances.get(hex) === i) instances.delete(hex);
      });
      i = new cls(state, env as { CONFIG: Config });
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
      // Nothing is let into the object until its gate opens, and nothing at all when it broke.
      await instance.ready;
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
        GATED: { idFromName(n: string): unknown; get(id: unknown): { read(): Promise<number> } };
      }
    ).GATED;
    try {
      return Response.json({ limit: await ns.get(ns.idFromName("g")).read() });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
};

async function runWith(
  requests: number,
  faults: Schedule["faults"],
  load: { returns: { limit: number } } | { throws: string } = { returns: { limit: 7 } },
  /** Whether the scenario seeds the object, which has the reset construct it before the run. */
  seeded = true,
) {
  const cls = makeGated();
  const env: Record<string, unknown> = {
    CONFIG: { fetch: async () => new Response(), connect: () => undefined },
  };
  const { namespace, helpers } = fakeNamespace(cls, env);
  env["GATED"] = namespace;
  const platform = createCloudflarePlatform({
    env,
    handler,
    schemas: {},
    durableObjects: helpers,
    exports: { Gated: cls },
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "gated",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http(
      Array.from({ length: requests }, () => ({ path: "/", method: "GET" })),
      { retries: 0 },
    ),
    setup: [
      durableObject("GATED", seeded ? { g: {} } : {}),
      service("CONFIG", { methods: { load } }),
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
  const run = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds: s.bounds });
  const log = await runOnce(s, platform, run);
  return { log, run };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
/** An error on the load the constructor makes behind its gate, in the first request. */
const loadFails: Schedule["faults"] = [
  { invocation: "req-1#1", ordinal: 1, fault: "error", target: "Service:CONFIG", op: "load" },
];

describe("an object whose callback behind its input gate fails", () => {
  test("is reset: when nothing enters it again it is woken inside the run, its constructor's call an effect of the wake", async () => {
    const { log, run } = await runWith(1, loadFails);
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toEqual([
      "req-1#1 call DO:GATED read",
      "req-1#1 call Service:CONFIG load",
      "req-1#1 fault Service:CONFIG load",
      "req-1#1 result DO:GATED read",
      "req-1#1 call Http:/ response",
      "req-1#1 result Http:/ response",
      // The caller got a 503 and does not resend.
      "platform call Http:/ gave_up",
      "platform result Http:/ gave_up",
      "wake:GATED:g:1#1 call DO:GATED wake",
      "wake:GATED:g:1#1 call Service:CONFIG load",
      "wake:GATED:g:1#1 result Service:CONFIG load",
      "wake:GATED:g:1#1 result DO:GATED wake",
      "platform snapshot DO:GATED snapshot",
    ]);
  });

  test("the next call constructs it again, inside that call, and no wake is needed", async () => {
    const { log, run } = await runWith(2, loadFails);
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).filter((l) => l.startsWith("req-2#1 "))).toEqual([
      "req-2#1 call DO:GATED read",
      "req-2#1 call Service:CONFIG load",
      "req-2#1 result Service:CONFIG load",
      "req-2#1 result DO:GATED read",
      "req-2#1 call Http:/ response",
      "req-2#1 result Http:/ response",
    ]);
    expect(lines(log).filter((l) => l.includes(" wake"))).toEqual([]);
  });

  test("an object whose constructor fails every time is not woken for ever: the run ends UNSUPPORTED and says why", async () => {
    // No fault is injected: the configuration service itself throws, so every construction breaks
    // the gate, the wake's included. The object is not seeded, so the reset does not construct it
    // (a seeded one would fail the reset itself).
    const { log, run } = await runWith(1, [], { throws: "the configuration is gone" }, false);
    expect(lines(log).filter((l) => l.endsWith("call DO:GATED wake"))).toHaveLength(2);
    expect(run.unsupportedReasons).toEqual([
      "Durable Object GATED g could not be woken at the end of the run: a callback behind its input gate failed each of the 2 times it was constructed for that, more often than the run's faults explain, so what its storage holds was not read as its next event would find it",
      // The snapshot cannot construct it either, and leaves it out.
      "Durable Object g could not be entered to read its storage for the snapshot (the configuration is gone)",
    ]);
    const snapshot = log.entries.find((e) => e.kind === "snapshot" && e.target === "DO:GATED");
    expect((snapshot?.payload as { tables?: object } | undefined)?.tables).toEqual({});
  });
});
