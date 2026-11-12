/**
 * An object's own database and bucket, in Node against a fake namespace: a
 * statement an object runs or an object it puts through `this.env` is the
 * scenario's, an effect of the invocation the object's code runs as and
 * open to its faults. The real stores run in workerd in the corpus.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { calleeEnv } from "./callees.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { FakeR2 } from "./fake-r2.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http, r2Bucket } from "./scenario.ts";

/** What happened in order, across the stores and the object's storage. */
let order: string[] = [];

/** A database as far as the proxy drives it: every statement run is kept, in order. */
class FakeD1 {
  readonly ran: { sql: string; params: readonly unknown[] }[] = [];
  private statement(sql: string, params: readonly unknown[]) {
    const run = async () => {
      order.push(`d1 ${sql}`);
      this.ran.push({ sql, params });
      return { results: this.ran.map((r) => ({ sql: r.sql })), meta: { changes: 1 } };
    };
    return {
      bind: (...values: unknown[]) => this.statement(sql, values),
      run,
      all: run,
      first: async () => (await run()).results[0] ?? null,
      raw: async () => (await run()).results.map((r) => [r.sql]),
    };
  }
  prepare(sql: string) {
    return this.statement(sql, []);
  }
  async batch(statements: readonly { run(): Promise<unknown> }[]) {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
  async exec(sql: string) {
    this.ran.push({ sql, params: [] });
    return { count: 1, duration: 0 };
  }
}

type Database = {
  prepare(sql: string): Statement;
  batch(statements: readonly Statement[]): Promise<unknown[]>;
};
type Statement = { bind(...values: unknown[]): Statement; run(): Promise<unknown> };

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

/** An object that keeps a file's bytes in a bucket and its record in a database. */
class Files {
  readonly ctx: { storage: FakeStorage };
  env: { DB: Database; BUCKET: R2Bucket; LIMIT: number };
  constructor(storage: FakeStorage, env: object) {
    this.ctx = { storage };
    this.env = env as Files["env"];
  }
  /** Inside the call: the claim in its own storage, then the row outside, then the mark that it is done. */
  async record(name: string) {
    await this.ctx.storage.put("claimed", name);
    await this.env.DB.prepare("INSERT INTO files (name) VALUES (?1)").bind(name).run();
    await this.ctx.storage.put("recorded", name);
    return "recorded";
  }
  /** Answers at once; the upload is work queued behind the answer. */
  async upload(name: string) {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await this.env.BUCKET.put(name, "bytes");
      await this.ctx.storage.put("uploaded", name);
    })().catch(() => {});
    return "accepted";
  }
  /** Two statements in one batch. */
  async both(name: string) {
    const db = this.env.DB;
    await db.batch([
      db.prepare("INSERT INTO files (name) VALUES (?1)").bind(name),
      db.prepare("UPDATE counts SET n = n + 1"),
    ]);
    return "both";
  }
  /** Builds its dependencies from env, prepares a statement, and runs nothing. */
  async idle() {
    const deps = { db: this.env.DB, bucket: this.env.BUCKET };
    deps.db.prepare("SELECT 1");
    return typeof deps.bucket === "object" ? this.env.LIMIT : -1;
  }
}

function fakeNamespace(envOf: () => object) {
  const storages = new Map<string, Backing>();
  const instances = new Map<string, Files>();
  const instanceOf = (hex: string) => {
    let i = instances.get(hex);
    if (!i) {
      let backing = storages.get(hex);
      if (!backing) {
        backing = new Backing();
        storages.set(hex, backing);
      }
      // The runtime constructs the object with the Worker's real env.
      i = new Files(new GatedStorage(backing), envOf());
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
      return {
        id,
        record: (n: string) => instanceOf(hex).record(n),
        upload: (n: string) => instanceOf(hex).upload(n),
        both: (n: string) => instanceOf(hex).both(n),
        idle: () => instanceOf(hex).idle(),
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

type Stub = Record<"record" | "upload" | "both" | "idle", (n: string) => Promise<unknown>>;

/** A Worker whose request calls the method its path names on the object "f". */
const handlerFor = (binding: string): WorkerHandler => ({
  async fetch(request, env) {
    const ns = (env as Record<string, { idFromName(n: string): unknown; get(id: unknown): Stub }>)[
      binding
    ];
    const method = new URL(request.url).pathname.slice(1) as keyof Stub;
    try {
      return Response.json({ value: await ns?.get(ns.idFromName("f"))[method]("a.txt") });
    } catch (err) {
      return new Response((err as Error).message, { status: 503 });
    }
  },
});

async function runOf(
  path: string,
  options: {
    faults?: Schedule["faults"];
    /** The binding names, when the object is a callee's: `<name>/FILES`, `<name>/DB`. */
    callee?: string;
    /** Leave the bucket out of the setup. */
    noBucketStep?: boolean;
  } = {},
) {
  order = [];
  const q = (name: string) => (options.callee === undefined ? name : `${options.callee}/${name}`);
  const env: Record<string, unknown> = {};
  const { namespace, helpers, storages } = fakeNamespace(() =>
    options.callee === undefined ? env : calleeEnv(options.callee, env),
  );
  const db = new FakeD1();
  const bucket = new FakeR2();
  Object.assign(env, {
    [q("FILES")]: namespace,
    [q("DB")]: db,
    [q("BUCKET")]: bucket,
    [q("LIMIT")]: 3,
  });
  const platform = createCloudflarePlatform({
    env,
    handler: handlerFor(q("FILES")),
    schemas: {},
    durableObjects: helpers,
  });
  const s: ScenarioSpec = {
    version: 1,
    name: "files",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http([{ path, method: "POST" }], { retries: 0 }),
    setup: [
      durableObject(q("FILES"), { f: {} }),
      ...(options.noBucketStep ? [] : [r2Bucket(q("BUCKET"))]),
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
  return { log, run, db, bucket, storage: storages.get("id-f")?.data };
}

const lines = (log: EffectLog) =>
  log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

describe("an object's statement on its own database", () => {
  test("inside a call it is an effect of the calling invocation, run on the real database", async () => {
    const { log, run, db, storage } = await runOf("/record");
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(0, 4)).toEqual([
      "req-1#1 call DO:FILES record",
      "req-1#1 call D1:DB run",
      "req-1#1 result D1:DB run",
      "req-1#1 result DO:FILES record",
    ]);
    const call = log.entries.find((e) => e.kind === "call" && e.target === "D1:DB");
    expect(call?.payload).toEqual({
      args: { sql: "INSERT INTO files (name) VALUES (?1)", params: ["a.txt"] },
    });
    expect(db.ran).toEqual([{ sql: "INSERT INTO files (name) VALUES (?1)", params: ["a.txt"] }]);
    expect(storage?.get("recorded")).toBe("a.txt");
  });

  test("it leaves the object once the writes before it are durable, and a crash after it finds them kept", async () => {
    await runOf("/record");
    expect(order).toEqual([
      "storage claimed",
      "sync",
      "d1 INSERT INTO files (name) VALUES (?1)",
      "storage recorded",
    ]);
    // The row is written and the object dies before it marks it: the claim stayed, the mark never came.
    const crashed = await runOf("/record", {
      faults: [
        { invocation: "req-1#1", ordinal: 1, fault: "crash_after", target: "D1:DB", op: "run" },
      ],
    });
    expect(crashed.run.unsupportedReasons).toEqual([]);
    expect(crashed.db.ran).toHaveLength(1);
    expect(crashed.storage?.get("claimed")).toBe("a.txt");
    expect(crashed.storage?.get("recorded")).toBeUndefined();
    expect(lines(crashed.log)).toContain("req-1#1 fault D1:DB run");
  });

  test("a statement that never left wrote nothing, and did not make the object's writes durable", async () => {
    const { db } = await runOf("/record", {
      faults: [
        { invocation: "req-1#1", ordinal: 1, fault: "crash_before", target: "D1:DB", op: "run" },
      ],
    });
    expect(db.ran).toEqual([]);
    expect(order).toEqual(["storage claimed"]);
  });

  test("a batch of statements prepared through its env is one effect naming each", async () => {
    const { log, run, db } = await runOf("/both");
    expect(run.unsupportedReasons).toEqual([]);
    const call = log.entries.find((e) => e.kind === "call" && e.op === "batch");
    expect(call?.invocation).toBe("req-1#1");
    expect(call?.payload).toEqual({
      args: {
        statements: [
          { sql: "INSERT INTO files (name) VALUES (?1)", params: ["a.txt"] },
          { sql: "UPDATE counts SET n = n + 1", params: [] },
        ],
      },
    });
    expect(lines(log).filter((l) => l.includes("D1:DB"))).toEqual([
      "req-1#1 call D1:DB batch",
      "req-1#1 result D1:DB batch",
    ]);
    expect(db.ran.map((r) => r.sql)).toEqual([
      "INSERT INTO files (name) VALUES (?1)",
      "UPDATE counts SET n = n + 1",
    ]);
  });

  test("a callee's object reaches the callee's database: DB there is <callee>/DB in the scenario", async () => {
    const { log, run, db } = await runOf("/record", { callee: "files" });
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(1, 3)).toEqual([
      "req-1#1 call D1:files/DB run",
      "req-1#1 result D1:files/DB run",
    ]);
    expect(db.ran).toHaveLength(1);
  });
});

describe("an object's operation on its own bucket", () => {
  test("in work after the answer it is an effect of the object's own invocation", async () => {
    const { log, run, bucket, storage } = await runOf("/upload");
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(log).slice(4, 6)).toEqual([
      "DO:FILES/f/after call R2:BUCKET put",
      "DO:FILES/f/after result R2:BUCKET put",
    ]);
    expect([...bucket.objects.keys()]).toEqual(["a.txt"]);
    expect(storage?.get("uploaded")).toBe("a.txt");
  });

  test("an answer lost on it leaves the object stored and the object's own record unwritten", async () => {
    const { run, bucket, storage } = await runOf("/upload", {
      faults: [
        {
          invocation: "DO:FILES/f/after",
          ordinal: 0,
          fault: "ambiguous",
          target: "R2:BUCKET",
          op: "put",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect([...bucket.objects.keys()]).toEqual(["a.txt"]);
    expect(storage?.get("uploaded")).toBeUndefined();
  });

  test("a bucket the scenario does not set up is UNSUPPORTED once the object uses it, as it is from the Worker", async () => {
    const used = await runOf("/upload", { noBucketStep: true });
    expect(used.run.unsupportedReasons).toEqual([
      "R2 binding BUCKET needs an r2Bucket() setup step, which empties it before each run",
    ]);
    // Reading it off env, and preparing a statement, are nothing.
    const idle = await runOf("/idle", { noBucketStep: true });
    expect(idle.run.unsupportedReasons).toEqual([]);
    expect(lines(idle.log).filter((l) => /D1:|R2:/.test(l))).toEqual([]);
  });
});
