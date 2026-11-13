/**
 * A scripted Durable Object namespace, in Node against fake namespaces: a
 * call on a stub of it, from the Worker or from another object, is one
 * effect answered from the scenario's `scriptedObject()` step, with a stub
 * call's faults, and no object of the namespace is constructed. The real
 * runtime is in the corpus.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { outsideRunEnv } from "./object-access.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import {
  defineScenario,
  durableObject,
  durableObjectTable,
  http,
  objectCall,
  type ScriptedObjectSetup,
  scriptedObject,
  unique,
} from "./scenario.ts";

/** What the calling object's storage did, in order; the objects a fault reset; machines constructed. */
let order: string[] = [];
let reset: string[] = [];
let constructed = 0;

/** A storage whose `sync()` is the runtime's: it makes the writes before it durable. */
class GatedStorage extends FakeStorage {
  override async put(key: string | Record<string, unknown>, value?: unknown) {
    order.push(`put ${String(key)}`);
    return super.put(key, value);
  }
  async sync(): Promise<void> {
    order.push("sync");
  }
}

interface MachineStub {
  readonly id: { toString(): string };
  readonly name?: string;
  start(job: string): Promise<{ started: string }>;
  stop(): Promise<null>;
  status: Promise<string> & (() => Promise<string>);
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
type Namespace<T> = {
  idFromName(name: string): { toString(): string };
  get(id: unknown): T;
  getByName?(name: string): T;
};
type Env = { JOBS: Namespace<Jobs>; MACHINE: Namespace<MachineStub> };

/** The class behind the scripted namespace: never to be constructed. */
class Machine {
  constructor() {
    constructed++;
  }
  async start() {
    return { started: "for real" };
  }
}

/** The object the Worker calls, which drives a machine of its own name. */
class Jobs {
  readonly ctx: { storage: FakeStorage };
  env: Env;
  /** The env the constructor was given, kept for itself: the simulation does not stand behind it. */
  readonly kept: Env;
  constructor(storage: FakeStorage, env: object) {
    this.ctx = { storage };
    this.env = env as Env;
    this.kept = env as Env;
  }
  /** Its machine through the env it kept, past the scenario's script. */
  async around(job: string) {
    return this.kept.MACHINE.get(this.kept.MACHINE.idFromName("j1")).start(job);
  }
  machine(): MachineStub {
    return this.env.MACHINE.get(this.env.MACHINE.idFromName("j1"));
  }
  /** Inside the call: its own note, the machine, then what it keeps. */
  async run(job: string) {
    await this.ctx.storage.put("asked", job);
    try {
      const { started } = await this.machine().start(job);
      await this.ctx.storage.put("running", started);
      return { started };
    } catch (err) {
      await this.ctx.storage.put("failed", (err as Error).message);
      return { failed: `${(err as Error).name}: ${(err as Error).message}` };
    }
  }
  /** Answers at once; the machine is started in work behind the answer. */
  async later(job: string) {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await this.machine().start(job);
    })().catch(() => {});
    return "accepted";
  }
  /** Its machine over HTTP, as a container-backed object is reached. */
  async ping() {
    const response = await this.machine().fetch("http://machine/health", { method: "POST" });
    return { status: response.status, body: await response.text() };
  }
}

const stubOf = Symbol("the fake runtime's handle on a stub's object");
type Instance = Record<string, (...args: unknown[]) => unknown>;

/** A namespace as the runtime gives it, constructing `make()` for each object reached. */
function fakeNamespace(label: string, make: (storage: FakeStorage) => object) {
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
      i = make(new GatedStorage(backing)) as Instance;
      instances.set(hex, i);
    }
    return i;
  };
  const idFor = (hex: string) => ({ toString: () => hex, equals: () => false });
  const namespace = {
    idFromName: (name: string) => idFor(`${label}-${name}`),
    idFromString: (hex: string) => idFor(hex),
    jurisdiction: () => namespace,
    newUniqueId: () => idFor(`${label}-random`),
    get: (id: { toString(): string }) => {
      const hex = id.toString();
      const handle = {
        run: (callback: (instance: unknown, state: object) => unknown) => {
          const instance = instanceOf(hex) as unknown as { ctx: { storage: FakeStorage } };
          return callback(instance, {
            storage: instance.ctx.storage,
            abort: () => {
              reset.push(hex);
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

/** A Worker whose request calls the method its path names on the object "j1" with the job "build". */
const viaObject = (binding: string): WorkerHandler => ({
  async fetch(request, env) {
    const ns = (env as Record<string, Namespace<Record<string, (j: string) => unknown>>>)[binding];
    const method = new URL(request.url).pathname.slice(1);
    try {
      return Response.json({ value: await ns?.get(ns.idFromName("j1"))[method]?.("build") });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
});

const script: Parameters<typeof scriptedObject>[1] = {
  methods: {
    start: { returns: { started: "s-1" } },
    stop: { throws: "RangeError: nothing to stop" },
    status: { returns: "idle" },
  },
  fetch: [
    { method: "POST", path: "/health", status: 200, body: "up" },
    { method: "GET", path: "/socket", status: 101 },
    { method: "GET", path: "/moved", status: 302, headers: { location: "/health" } },
  ],
};

async function runOf(
  handler: (q: (name: string) => string) => WorkerHandler,
  options: {
    path?: string;
    faults?: Schedule["faults"];
    /** The binding names, when the objects are a callee's: `<name>/JOBS`, `<name>/MACHINE`. */
    callee?: string;
    script?: Parameters<typeof scriptedObject>[1];
    /** The machines' namespace as an earlier scenario left it, in place of a new one. */
    machines?: ReturnType<typeof fakeNamespace>;
    /** Give the platform no test helpers (and leave the real objects' namespace out of the setup). */
    noHelpers?: boolean;
  } = {},
) {
  order = [];
  reset = [];
  constructed = 0;
  const q = (name: string) => (options.callee === undefined ? name : `${options.callee}/${name}`);
  const env: Record<string, unknown> = {};
  const envOf = () => (options.callee === undefined ? env : calleeEnv(options.callee, env));
  const jobs = fakeNamespace("jobs", (storage) => new Jobs(storage, envOf()));
  const machines = options.machines ?? fakeNamespace("machine", () => new Machine());
  const all = [jobs, machines];
  Object.assign(env, { [q("JOBS")]: jobs.namespace, [q("MACHINE")]: machines.namespace });
  const platform = createCloudflarePlatform({
    env,
    handler: handler(q),
    schemas: {},
    ...(options.noHelpers
      ? {}
      : {
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
        }),
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "jobs",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path: options.path ?? "/run", method: "POST" }], { retries: 0 }),
    setup: [
      ...(options.noHelpers ? [] : [durableObject(q("JOBS"), { j1: {} })]),
      scriptedObject(q("MACHINE"), options.script ?? script),
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
  return { log, run, jobs: jobs.storages.get("jobs-j1")?.data };
}

const lines = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

const fault = (
  ordinal: number,
  kind: "crash_before" | "crash_after" | "ambiguous" | "error",
): Schedule["faults"] => [
  { invocation: "req-1#1", ordinal, fault: kind, target: "DO:MACHINE", op: "start" },
];

/** A Worker that calls the machine itself and answers with what `use` made of its stub. */
const direct =
  (use: (stub: MachineStub, ns: Namespace<MachineStub>) => unknown) =>
  (q: (name: string) => string): WorkerHandler => ({
    async fetch(_request, env) {
      const ns = (env as Record<string, Namespace<MachineStub>>)[q("MACHINE")];
      if (!ns) return new Response("no binding", { status: 500 });
      try {
        return Response.json({ value: await use(ns.get(ns.idFromName("j1")), ns) });
      } catch (err) {
        return Response.json({ threw: `${(err as Error).name}: ${(err as Error).message}` });
      }
    },
  });

/** What the Worker answered, from the recorded response. */
async function answerOf(use: (stub: MachineStub, ns: Namespace<MachineStub>) => unknown) {
  let seen: unknown;
  const { log, run } = await runOf(
    direct(async (stub, ns) => {
      try {
        seen = { value: await use(stub, ns) };
      } catch (err) {
        seen = { threw: `${(err as Error).name}: ${(err as Error).message}` };
      }
      return null;
    }),
  );
  return { log, run, seen };
}

describe("a scripted Durable Object, called from the Worker", () => {
  test("a method call is one effect on the namespace, answered from the script, and no object is constructed", async () => {
    const { log, run, seen } = await answerOf((stub) => stub.start("build"));
    expect(run.unsupportedReasons).toEqual([]);
    expect(seen).toEqual({ value: { started: "s-1" } });
    expect(lines(log).slice(0, 2)).toEqual([
      "req-1#1 call DO:MACHINE start",
      "req-1#1 result DO:MACHINE start",
    ]);
    const call = log.entries.find((e) => e.kind === "call" && e.target === "DO:MACHINE");
    expect(call?.payload).toEqual({ args: { object: "j1", args: ["build"] } });
    expect(constructed).toBe(0);
  });

  test("a scripted error is thrown as the class RPC would carry", async () => {
    const { run, seen } = await answerOf((stub) => stub.stop());
    expect(run.unsupportedReasons).toEqual([]);
    expect(seen).toEqual({ threw: "RangeError: nothing to stop" });
  });

  test("an RPC property awaited is the same effect", async () => {
    const { log, run, seen } = await answerOf((stub) => stub.status);
    expect(run.unsupportedReasons).toEqual([]);
    expect(seen).toEqual({ value: "idle" });
    const call = log.entries.find((e) => e.kind === "call" && e.target === "DO:MACHINE");
    expect(call?.payload).toEqual({ args: { object: "j1", property: true } });
  });

  test("the caller holds a copy of the scripted value", async () => {
    const { seen } = await answerOf(async (stub) => {
      const first = await stub.start("a");
      (first as { started: string }).started = "changed";
      return stub.start("b");
    });
    expect(seen).toEqual({ value: { started: "s-1" } });
  });

  test("fetch is answered from the scripted replies, matched by method and path, the request recorded", async () => {
    const { log, run, seen } = await answerOf(async (stub) => {
      const r = await stub.fetch("http://machine/health", { method: "POST", body: '{"n":1}' });
      return { status: r.status, body: await r.text() };
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(seen).toEqual({ value: { status: 200, body: "up" } });
    const call = log.entries.find((e) => e.kind === "call" && e.target === "DO:MACHINE");
    expect(call?.op).toBe("fetch");
    expect(call?.payload).toMatchObject({
      args: { object: "j1", url: "http://machine/health", method: "POST", body: { n: 1 } },
    });
    const result = log.entries.find((e) => e.kind === "result" && e.target === "DO:MACHINE");
    expect(result?.payload).toMatchObject({ result: { status: 200, ok: true } });
  });

  test("the stub's id is the namespace's own, and getByName names the same object", async () => {
    const { log, seen } = await answerOf(async (stub, ns) => {
      await ns.getByName?.("j1").start("x");
      return stub.id.toString();
    });
    expect(seen).toEqual({ value: "machine-j1" });
    const call = log.entries.find((e) => e.kind === "call" && e.target === "DO:MACHINE");
    expect(call?.payload).toEqual({ args: { object: "j1", args: ["x"] } });
  });

  test.each([
    [
      "a method the script lacks",
      (stub: MachineStub) => (stub as never as { wipe(): unknown }).wipe(),
      'scripted Durable Object MACHINE j1: no scripted reply for method wipe; add it to the scriptedObject("MACHINE") setup\'s methods',
    ],
    [
      "a fetch no reply matches",
      (stub: MachineStub) => stub.fetch("http://machine/other"),
      'scripted Durable Object MACHINE j1: no scripted reply for fetch GET /other; add it to the scriptedObject("MACHINE") setup\'s fetch',
    ],
    [
      "a 101 reply",
      (stub: MachineStub) => stub.fetch("http://machine/socket"),
      "scripted Durable Object MACHINE j1: the scripted reply to GET /socket is a 101, and a scripted object accepts no WebSocket",
    ],
    [
      "a redirect the runtime would follow",
      (stub: MachineStub) => stub.fetch("http://machine/moved"),
      'scripted Durable Object MACHINE j1: the scripted reply to GET /moved is a 302 redirect, which the runtime would follow; script the final reply or fetch with redirect: "manual"',
    ],
    [
      "a read on a call's promise",
      (stub: MachineStub) => (stub.start("x") as unknown as { started: unknown }).started,
      "scripted Durable Object MACHINE j1: RPC promise pipelining (reading .started on start()'s promise) is not supported; await the call first",
    ],
  ])("%s makes the run UNSUPPORTED with the reason", async (_name, use, reason) => {
    const { run } = await answerOf(use);
    expect(run.unsupportedReasons).toEqual([reason]);
    expect(constructed).toBe(0);
  });

  test("a namespace scripted without methods answers every method with null", async () => {
    let seen: unknown = "unset";
    const { run } = await runOf(
      direct(async (stub) => {
        seen = await stub.start("x");
        return null;
      }),
      { script: {} },
    );
    expect(run.unsupportedReasons).toEqual([]);
    expect(seen).toBeNull();
  });
});

describe("a scripted Durable Object, called from another object", () => {
  test("inside a call it is an effect of the calling invocation, leaving once the caller's writes are durable", async () => {
    const { log, run, jobs } = await runOf((q) => viaObject(q("JOBS")));
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(0, 4)).toEqual([
      "req-1#1 call DO:JOBS run",
      "req-1#1 call DO:MACHINE start",
      "req-1#1 result DO:MACHINE start",
      "req-1#1 result DO:JOBS run",
    ]);
    expect(order).toEqual(["put asked", "sync", "put running"]);
    expect(jobs?.get("running")).toBe("s-1");
    expect(constructed).toBe(0);
  });

  test("in work after the answer it is the calling object's own invocation's", async () => {
    const { log, run } = await runOf((q) => viaObject(q("JOBS")), { path: "/later" });
    expect(run.unsupportedReasons).toEqual([]);
    const all = lines(log);
    expect(all).toContain("DO:JOBS/j1/after call DO:MACHINE start");
    expect(all).toContain("DO:JOBS/j1/after result DO:MACHINE start");
  });

  test("its fetch is answered from the script too", async () => {
    const { log, run } = await runOf((q) => viaObject(q("JOBS")), { path: "/ping" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 result DO:MACHINE fetch");
    const result = log.entries.find((e) => e.kind === "result" && e.target === "DO:JOBS");
    expect(result?.payload).toMatchObject({ result: { status: 200, body: "up" } });
  });

  test("a callee's objects reach it under the callee's name", async () => {
    const { log, run, jobs } = await runOf((q) => viaObject(q("JOBS")), { callee: "runtime" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 result DO:runtime/MACHINE start");
    expect(jobs?.get("running")).toBe("s-1");
  });

  test("crash_before: the call never left, and the calling object is reset", async () => {
    const { log, run, jobs } = await runOf((q) => viaObject(q("JOBS")), {
      faults: fault(1, "crash_before"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log)).toContain("req-1#1 fault DO:MACHINE start");
    expect(lines(log)).not.toContain("req-1#1 result DO:MACHINE start");
    expect(reset).toEqual(["jobs-j1"]);
    expect(jobs?.get("asked")).toBe("build");
    expect(jobs?.get("running")).toBeUndefined();
  });

  test("error: the call never reached the object, and the calling object sees an error and goes on", async () => {
    const { run, jobs } = await runOf((q) => viaObject(q("JOBS")), { faults: fault(1, "error") });
    expect(run.unsupportedReasons).toEqual([]);
    expect(reset).toEqual([]);
    expect(jobs?.get("running")).toBeUndefined();
    expect(jobs?.has("failed")).toBe(true);
  });

  test("ambiguous: the object acted and the answer was lost; the calling object sees an error", async () => {
    const { log, run, jobs } = await runOf((q) => viaObject(q("JOBS")), {
      faults: fault(1, "ambiguous"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(reset).toEqual([]);
    expect(lines(log)).toContain("req-1#1 fault DO:MACHINE start");
    expect(jobs?.get("running")).toBeUndefined();
    expect(jobs?.has("failed")).toBe(true);
  });

  test("crash_after: the object acted, and the calling object died before it kept the answer", async () => {
    const { run, jobs } = await runOf((q) => viaObject(q("JOBS")), {
      faults: fault(1, "crash_after"),
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(reset).toEqual(["jobs-j1"]);
    expect(jobs?.get("running")).toBeUndefined();
    expect(jobs?.has("failed")).toBe(false);
  });
});

describe("a scripted namespace's real object", () => {
  test("reached through an env a constructor kept, it runs for real: the run is UNSUPPORTED and says which", async () => {
    const { log, run } = await runOf((q) => viaObject(q("JOBS")), { path: "/around" });
    expect(constructed).toBe(1);
    // The call was no effect of the run's.
    expect(lines(log).filter((l) => l.includes("DO:MACHINE"))).toEqual([]);
    expect(run.unsupportedReasons).toEqual([
      "Durable Object MACHINE machine-j1, of a namespace the scenario scripts, ran for real: something called it through an env the simulation does not stand behind (the env parameter a constructor kept, or a class the platform was not given)",
    ]);
  });

  test("left running by a scenario that ran the namespace's real objects, it is evicted before the run and is not the run's", async () => {
    const machines = fakeNamespace("machine", () => new Machine());
    // As an earlier scenario with durableObject("MACHINE") leaves it: constructed and up.
    const left = machines.namespace.get(machines.namespace.idFromName("j1")) as unknown as {
      start(): Promise<unknown>;
    };
    await left.start();
    const { run } = await runOf((q) => viaObject(q("JOBS")), { machines });
    expect(run.unsupportedReasons).toEqual([]);
    // The run constructed none: the one was the earlier scenario's.
    expect(constructed).toBe(0);
  });

  test("without the test helpers nothing could tell, so no run is made: the setup says it needs them", async () => {
    await expect(
      runOf(
        direct((stub) => stub.start("x")),
        { noHelpers: true },
      ),
    ).rejects.toThrow(
      "scriptedObject setup needs the Cloudflare test helpers, to see that none of the namespace's objects ran",
    );
  });
});

describe("the scriptedObject step", () => {
  const base = {
    name: "s",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path: "/", method: "GET" }]),
    invariants: [],
  };

  test("a namespace is the real objects or a script, not both", () => {
    expect(() =>
      defineScenario({ ...base, setup: [durableObject("MACHINE"), scriptedObject("MACHINE")] }),
    ).toThrow(
      'Durable Object binding "MACHINE" has both a durableObject() setup and a scriptedObject() script; keep one',
    );
  });

  test("one script per namespace", () => {
    expect(() =>
      defineScenario({ ...base, setup: [scriptedObject("MACHINE"), scriptedObject("MACHINE")] }),
    ).toThrow('Durable Object binding "MACHINE" has two scriptedObject() steps');
  });

  test("an invariant cannot read the storage of a scripted namespace: it has none", () => {
    expect(() =>
      defineScenario({
        ...base,
        setup: [scriptedObject("MACHINE")],
        invariants: [unique("one-row", durableObjectTable("MACHINE", "j1", "jobs"), "id")],
      }),
    ).toThrow(
      'invariant "one-row" reads the storage of MACHINE, a namespace the scenario scripts: a script has no storage; select its calls with objectCall()',
    );
  });

  test("objectCall selects the calls that completed, by method and by object", () => {
    expect(objectCall("MACHINE")).toEqual({ target: "DO:MACHINE", kind: "result" });
    expect(objectCall("MACHINE", "start", "j1")).toEqual({
      target: "DO:MACHINE",
      op: "start",
      kind: "result",
      where: { "args.object": "j1" },
    });
  });
});

describe("outsideRunEnv: a scripted namespace", () => {
  const real = fakeNamespace("machine", () => new Machine()).namespace;
  const scripted = (name: string): ScriptedObjectSetup | undefined =>
    name === "MACHINE" ? scriptedObject("MACHINE", script) : undefined;

  test("a method a constructor calls while its object is reset answers from the script; anything else is refused", async () => {
    constructed = 0;
    const env = outsideRunEnv({ MACHINE: real, OTHER: real }, scripted) as {
      MACHINE: Namespace<MachineStub>;
      OTHER: Namespace<MachineStub>;
    };
    const stub = env.MACHINE.get(env.MACHINE.idFromName("j1"));
    await expect(stub.start("x")).resolves.toEqual({ started: "s-1" });
    await expect(stub.stop()).rejects.toThrow(RangeError);
    await expect(stub.fetch("http://machine/health")).rejects.toThrow(
      "the scriptedObject() script does not answer it",
    );
    await expect(env.OTHER.get(env.OTHER.idFromName("j1")).start("x")).rejects.toThrow(
      "where a call into another object is not made",
    );
    expect(constructed).toBe(0);
  });
});
