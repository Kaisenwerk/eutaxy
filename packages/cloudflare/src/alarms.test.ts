/**
 * Durable Object alarms in virtual time, in Node against a fake namespace:
 * firing at the alarm's time, one alarm per object, transactions, retries
 * with backoff, at-least-once under crashes, the per-run firing bound, and
 * alarms that outlive an instance. The real objects run in workerd in the
 * corpus.
 */
import type { EffectLog, FaultDecision, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { Run, replayChooser, runOnce, virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { alarmRunner, BindingState } from "./durable-objects.ts";
import { Backing, FakeStorage } from "./fake-durable-objects.ts";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { durableObject, http } from "./scenario.ts";

/** A virtual time as milliseconds since the start of the run. */
const since = () => Date.now() - virtualEpoch;

/**
 * Runs scheduled tasks from its alarm: tasks are stored with their due time,
 * the alarm is set to the earliest one (several schedules over one alarm),
 * and every firing is recorded in storage.
 */
class Reminder {
  readonly ctx: { storage: FakeStorage };
  /** In-memory only: lost when the object crashes or is evicted. */
  private remembered = false;
  constructor(storage: FakeStorage) {
    this.ctx = { storage };
    // Like an object that arms itself when it is built, before Eutaxy takes over its storage.
    if (constructorArms) void storage.setAlarm(virtualEpoch + since() + 30_000);
    if (constructorReads) void storage.getAlarm();
  }
  private async tasks(): Promise<number[]> {
    return ((await this.ctx.storage.get("tasks")) as number[] | undefined) ?? [];
  }
  async schedule(...delays: number[]) {
    const tasks = [...(await this.tasks()), ...delays.map((d) => since() + d)].sort(
      (a, b) => a - b,
    );
    await this.ctx.storage.put("tasks", tasks);
    if (tasks[0] !== undefined) await this.ctx.storage.setAlarm(virtualEpoch + tasks[0]);
  }
  async replace(first: number, second: number) {
    await this.ctx.storage.setAlarm(virtualEpoch + since() + first);
    await this.ctx.storage.setAlarm(virtualEpoch + since() + second);
  }
  async noop() {}
  /** Fails its first call; the resend records what getAlarm() says then. */
  async recordAlarmOnSecondCall() {
    if (!(await this.ctx.storage.get("called"))) {
      await this.ctx.storage.put("called", true);
      throw new Error("not yet");
    }
    await this.ctx.storage.put("seen", await this.ctx.storage.getAlarm());
  }
  /** Fails its first call (the caller resends later); the resend arms the alarm. */
  async armOnSecondCall(delay: number) {
    if (!(await this.ctx.storage.get("called"))) {
      await this.ctx.storage.put("called", true);
      throw new Error("not yet");
    }
    await this.ctx.storage.setAlarm(virtualEpoch + since() + delay);
  }
  inSyncTransaction(delay: number) {
    this.ctx.storage.transactionSync(() => {
      void this.ctx.storage.setAlarm(virtualEpoch + since() + delay);
    });
  }
  async past(by: number) {
    await this.ctx.storage.setAlarm(Date.now() - by);
  }
  async cancel(delay: number) {
    await this.ctx.storage.setAlarm(virtualEpoch + since() + delay);
    await this.ctx.storage.deleteAlarm();
  }
  async inTransaction(delay: number, ending: "commit" | "throw" | "rollback") {
    try {
      await this.ctx.storage.transaction(async (txn) => {
        await txn.setAlarm(virtualEpoch + since() + delay);
        if (ending === "throw") throw new Error("abort");
        if (ending === "rollback") txn.rollback();
      });
    } catch {
      // the aborted transaction
    }
  }
  /** Sets an alarm only on the first of two transaction attempts; the second sets none. */
  async firstAttemptOnly(delay: number) {
    this.ctx.storage.backing.transactionAttempts = 2;
    let attempts = 0;
    await this.ctx.storage.transaction(async (txn) => {
      attempts++;
      if (attempts === 1) await txn.setAlarm(virtualEpoch + since() + delay);
    });
  }
  async failFirst(times: number) {
    await this.ctx.storage.put("failures", times);
    await this.ctx.storage.setAlarm(virtualEpoch + since() + 1000);
  }
  async rearmEvery(interval: number) {
    await this.ctx.storage.put("rearm", interval);
    await this.ctx.storage.setAlarm(virtualEpoch + since() + interval);
  }
  /** Gets the object reset after setting its alarm, as an eviction does. */
  async armThenReset(delay: number) {
    await this.ctx.storage.setAlarm(virtualEpoch + since() + delay);
    dropInstance?.();
  }
  /** Sends the reminder through the mail API from the alarm, then marks it sent. */
  async armSend(delay: number) {
    await this.ctx.storage.put("send", true);
    await this.ctx.storage.setAlarm(virtualEpoch + since() + delay);
  }
  async alarm(info: { retryCount: number; isRetry: boolean }) {
    const fired = ((await this.ctx.storage.get("fired")) as unknown[] | undefined) ?? [];
    await this.ctx.storage.put("fired", [
      ...fired,
      { at: since(), ...info, remembered: this.remembered },
    ]);
    this.remembered = true;
    if (await this.ctx.storage.get("send")) {
      await fetch("https://mail.test/send", { method: "POST" });
      await this.ctx.storage.put("sent", true);
    }
    const failures = ((await this.ctx.storage.get("failures")) as number | undefined) ?? 0;
    if (failures > 0) {
      await this.ctx.storage.put("failures", failures - 1);
      throw new Error("alarm failed");
    }
    const rearm = (await this.ctx.storage.get("rearm")) as number | undefined;
    if (rearm) await this.ctx.storage.setAlarm(virtualEpoch + since() + rearm);
    const due = (await this.tasks()).filter((t) => t > since());
    await this.ctx.storage.put("tasks", due);
    if (due[0] !== undefined) await this.ctx.storage.setAlarm(virtualEpoch + due[0]);
  }
}

let dropInstance: (() => void) | null = null;
/** When set, every Reminder sets an alarm in its constructor. */
let constructorArms = false;
/** When set, every Reminder reads its alarm in its constructor. */
let constructorReads = false;

function fakeNamespace() {
  const backings = new Map<string, Backing>();
  const instances = new Map<string, Reminder>();
  const aborted: string[] = [];
  const instanceOf = (hex: string) => {
    let i = instances.get(hex);
    if (!i) {
      let b = backings.get(hex);
      if (!b) {
        b = new Backing();
        backings.set(hex, b);
      }
      i = new Reminder(new FakeStorage(b));
      instances.set(hex, i);
    }
    return i;
  };
  dropInstance = () => instances.delete("id-r");
  const idFor = (hex: string) => ({ toString: () => hex, equals: () => false });
  const namespace = {
    idFromName: (name: string) => idFor(`id-${name}`),
    idFromString: (hex: string) => idFor(hex),
    get: (id: { toString(): string }) =>
      new Proxy(
        { id },
        {
          get: (target, prop) =>
            prop === "id"
              ? target.id
              : (...args: unknown[]) =>
                  (
                    instanceOf(id.toString()) as unknown as Record<
                      string,
                      (...a: unknown[]) => unknown
                    >
                  )[String(prop)]?.(...args),
        },
      ),
  };
  const helpers = {
    runInDurableObject: async (
      stub: { id: { toString(): string } },
      callback: (
        instance: unknown,
        state: { storage: FakeStorage; abort(reason?: string): void },
      ) => unknown,
    ) => {
      const hex = stub.id.toString();
      const instance = instanceOf(hex);
      return callback(instance, {
        storage: instance.ctx.storage,
        // Like ctx.abort(): the object is reset; its pending work is dropped.
        abort: () => {
          aborted.push(hex);
          instances.delete(hex);
        },
      });
    },
    evictDurableObject: async (stub: { id: { toString(): string } }) => {
      if (!instances.delete(stub.id.toString())) throw new Error("not running");
    },
    listDurableObjectIds: async () => [...backings.keys()].map(idFor),
  };
  return { namespace, helpers, backings, aborted };
}

/** A Worker that calls the reminder object "r" with the method and arguments in the request body. */
const handler: WorkerHandler = {
  async fetch(request, env) {
    const { method, args, andThen } = (await request.json()) as {
      method: string;
      args: unknown[];
      andThen?: string;
    };
    const ns = (
      env as { REMINDER: { getByName(n: string): Record<string, (...a: unknown[]) => unknown> } }
    ).REMINDER;
    try {
      await ns.getByName("r")[method]?.(...args);
      if (andThen) await ns.getByName("r")[andThen]?.();
    } catch {
      return new Response("failed", { status: 500 });
    }
    return new Response("ok");
  },
};

async function runWith(
  method: string,
  args: unknown[],
  options: {
    faults?: FaultDecision[];
    alarmsPerObject?: number;
    maxRedeliveries?: number;
    /** A second method the Worker calls after the first. */
    andThen?: string;
    /** A second request, which its caller resends once after `resendAfterMs` if it fails. */
    second?: { method: string; args: unknown[]; resendAfterMs: number };
  } = {},
): Promise<{
  log: EffectLog;
  run: Run;
  fired: { at: number; retryCount: number; isRetry: boolean }[];
  aborted: string[];
}> {
  const { namespace, helpers, backings, aborted } = fakeNamespace();
  const platform = createCloudflarePlatform({
    env: { REMINDER: namespace },
    handler,
    schemas: {},
    durableObjects: helpers,
  });
  const spec: ScenarioSpec = {
    version: 1,
    name: "reminder",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: http(
      [
        {
          path: "/call",
          body: { method, args, ...(options.andThen ? { andThen: options.andThen } : {}) } as never,
        },
        ...(options.second
          ? [
              {
                path: "/call",
                body: { method: options.second.method, args: options.second.args } as never,
              },
            ]
          : []),
      ],
      options.second ? { retries: 1, delaysMs: [options.second.resendAfterMs] } : { retries: 0 },
    ),
    setup: [
      durableObject(
        "REMINDER",
        { r: {} },
        options.alarmsPerObject === undefined ? {} : { alarmsPerObject: options.alarmsPerObject },
      ),
    ],
    externals: [{ name: "mail", host: "mail.test", guarantees: {} }],
    invariants: [],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: options.maxRedeliveries ?? 6,
      maxConcurrentInvocations: 1,
      budgetMs: 10_000,
    },
  };
  const run = new Run({
    chooser: replayChooser({ seed: 1, faults: options.faults ?? [] }),
    bounds: spec.bounds,
  });
  const log = await runOnce(spec, platform, run);
  const fired = (backings.get("id-r")?.data.get("fired") ?? []) as {
    at: number;
    retryCount: number;
    isRetry: boolean;
  }[];
  return { log, run, fired, aborted };
}

describe("Durable Object alarms", () => {
  test("an alarm fires at its virtual time, as its own invocation", async () => {
    const { log, run, fired } = await runWith("schedule", [60_000]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.at).toBeGreaterThanOrEqual(60_000);
    expect(fired[0]?.at).toBeLessThan(60_010);
    const alarm = log.entries.find((e) => e.kind === "call" && e.op === "alarm");
    expect(alarm?.invocation).toMatch(/^alarm:REMINDER:r:\d+#1$/);
  });

  test("several schedules over one alarm each run once, in time order", async () => {
    const { fired } = await runWith("schedule", [5_000, 1_000, 3_000]);
    expect(fired.map((f) => Math.round(f.at / 1000))).toEqual([1, 3, 5]);
  });

  test("an alarm set in the past fires right away", async () => {
    const { fired } = await runWith("past", [5_000]);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.at).toBeLessThan(10);
  });

  test("a later setAlarm replaces the earlier one, and deleteAlarm cancels it", async () => {
    const replaced = await runWith("replace", [1_000, 9_000]);
    expect(replaced.fired.map((f) => Math.round(f.at / 1000))).toEqual([9]);
    expect((await runWith("cancel", [1_000])).fired).toEqual([]);
  });

  test("setAlarm in a transaction applies on commit only", async () => {
    expect((await runWith("inTransaction", [1_000, "commit"])).fired).toHaveLength(1);
    expect((await runWith("inTransaction", [1_000, "throw"])).fired).toEqual([]);
    expect((await runWith("inTransaction", [1_000, "rollback"])).fired).toEqual([]);
  });

  test("a failing handler is retried after 2 s, then 4 s, with retryCount and isRetry", async () => {
    const { fired } = await runWith("failFirst", [2]);
    expect(fired.map((f) => [f.retryCount, f.isRetry])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ]);
    const [first, second, third] = fired as unknown as [
      { at: number },
      { at: number },
      { at: number },
    ];
    expect(second.at - first.at).toBeGreaterThanOrEqual(2_000);
    expect(second.at - first.at).toBeLessThan(2_010);
    expect(third.at - second.at).toBeGreaterThanOrEqual(4_000);
    expect(third.at - second.at).toBeLessThan(4_010);
  });

  test("retries stop at maxRedeliveries, and giving up is recorded", async () => {
    const { log, fired } = await runWith("failFirst", [10], { maxRedeliveries: 2 });
    expect(fired).toHaveLength(3);
    expect(log.entries.some((e) => e.op === "alarm_gave_up")).toBe(true);
  });

  test("crash_after on the alarm: it ran and committed, and runs again (at least once)", async () => {
    const { fired } = await runWith("schedule", [1_000], {
      faults: [
        {
          invocation: "alarm:REMINDER:r:1#1",
          ordinal: 0,
          fault: "crash_after",
          target: "DO:REMINDER",
          op: "alarm",
        },
      ],
    });
    expect(fired.map((f) => f.retryCount)).toEqual([0, 1]);
  });

  test("crash_before on the alarm: it never ran, and runs on the retry", async () => {
    const { fired } = await runWith("schedule", [1_000], {
      faults: [
        {
          invocation: "alarm:REMINDER:r:1#1",
          ordinal: 0,
          fault: "crash_before",
          target: "DO:REMINDER",
          op: "alarm",
        },
      ],
    });
    expect(fired.map((f) => f.retryCount)).toEqual([1]);
  });

  test("an object that keeps re-arming fires alarmsPerObject times, then stops", async () => {
    const bounded = await runWith("rearmEvery", [1_000]);
    expect(bounded.fired).toHaveLength(3);
    expect(bounded.log.entries.some((e) => e.op === "alarm_not_fired")).toBe(true);
    expect((await runWith("rearmEvery", [1_000], { alarmsPerObject: 5 })).fired).toHaveLength(5);
  });

  test("an alarm outlives the instance that set it", async () => {
    const { run, fired } = await runWith("armThenReset", [1_000]);
    expect(run.unsupportedReasons).toEqual([]);
    expect(fired).toHaveLength(1);
  });

  test("a crash inside the alarm's own call resets the object, so no request is left hanging", async () => {
    const { run, fired, aborted } = await runWith("armSend", [1_000], {
      faults: [
        {
          invocation: "alarm:REMINDER:r:1#1",
          ordinal: 1,
          fault: "crash_after",
          target: "Fetch:mail",
          op: "POST",
        },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(aborted).toEqual(["id-r"]);
    // The retry runs on a fresh instance and sends again: at least once.
    expect(fired.map((f) => f.retryCount)).toEqual([0, 1]);
  });

  test("an alarm set only in a discarded transaction attempt is not committed", async () => {
    expect((await runWith("firstAttemptOnly", [1_000])).fired).toEqual([]);
  });

  test("a rebuilt object's constructor cannot silently replace an alarm still pending", async () => {
    constructorArms = true;
    try {
      // The alarm is set and the instance reset; a second call rebuilds it, and the constructor
      // arms again although an alarm is still pending (natively it would have seen that alarm).
      const { run, fired } = await runWith("armThenReset", [1_000], { andThen: "noop" });
      expect(run.unsupportedReasons.join()).toContain(
        "constructor set an alarm while one was pending",
      );
      // The pending alarm keeps its time; the constructor's does not replace it.
      expect(fired[0]?.at).toBeLessThan(1_010);
    } finally {
      constructorArms = false;
    }
  });

  test("crash_after on the alarm resets the instance: in-memory state does not survive the crash", async () => {
    const { fired } = await runWith("schedule", [1_000], {
      faults: [
        {
          invocation: "alarm:REMINDER:r:1#1",
          ordinal: 0,
          fault: "crash_after",
          target: "DO:REMINDER",
          op: "alarm",
        },
      ],
    });
    expect(fired.map((f) => (f as unknown as { remembered: boolean }).remembered)).toEqual([
      false,
      false,
    ]);
  });

  test("setAlarm inside transactionSync makes the run UNSUPPORTED", async () => {
    const { run } = await runWith("inSyncTransaction", [1_000]);
    expect(run.unsupportedReasons.join()).toContain("transactionSync");
  });

  test("a rebuild to run the alarm also sees it pending, so a constructor that re-arms is reported", async () => {
    constructorArms = true;
    try {
      const { run } = await runWith("armThenReset", [1_000]);
      expect(run.unsupportedReasons.join()).toContain(
        "constructor set an alarm while one was pending",
      );
    } finally {
      constructorArms = false;
    }
  });

  test("an alarm superseded at the same time is dropped before any fault, so it cannot retry", async () => {
    const { fired } = await runWith("replace", [1_000, 1_000], {
      faults: [
        {
          invocation: "alarm:REMINDER:r:1#1",
          ordinal: 0,
          fault: "crash_before",
          target: "DO:REMINDER",
          op: "alarm",
        },
      ],
    });
    expect(fired.map((f) => f.retryCount)).toEqual([0]);
  });

  test("a newer alarm set before a failed alarm's retry replaces the retry, and fires", async () => {
    // The first alarm fails at 1 s (retry due at 3 s); a resend at 1.5 s sets a new one for 6.5 s.
    const { fired } = await runWith("failFirst", [1], {
      second: { method: "armOnSecondCall", args: [5_000], resendAfterMs: 1_500 },
    });
    expect(fired.map((f) => [Math.round(f.at / 500) / 2, f.retryCount])).toEqual([
      [1, 0],
      [6.5, 0],
    ]);
  });

  test("an alarm superseded while its effect waited for a turn does not run its handler", async () => {
    const { namespace, helpers, backings } = fakeNamespace();
    const state = new BindingState();
    // The alarm being delivered is generation 1; a later setAlarm made it generation 2.
    state.alarms.entry("id-r").gen = 2;
    const hooks = { enqueue: () => {}, unsupported: () => {} } as unknown as RunHooks;
    const run = alarmRunner(
      namespace as unknown as DurableObjectNamespace,
      "REMINDER",
      { hooks, currentInvocation: () => "i" },
      helpers,
      state,
    );
    await run("id-r", "r", { retryCount: 0, isRetry: false }, 1);
    expect(backings.get("id-r")?.data.get("fired")).toBeUndefined();
  });

  test("an alarm given up on after its retries is no longer reported by getAlarm()", async () => {
    const neverRan = (attempt: number) => ({
      invocation: `alarm:REMINDER:r:1#${attempt}`,
      ordinal: 0,
      fault: "crash_before" as const,
      target: "DO:REMINDER",
      op: "alarm",
    });
    const { log } = await runWith("schedule", [1_000], {
      maxRedeliveries: 1,
      faults: [neverRan(1), neverRan(2)],
      second: { method: "recordAlarmOnSecondCall", args: [], resendAfterMs: 10_000 },
    });
    expect(log.entries.some((e) => e.op === "alarm_gave_up")).toBe(true);
    const seen = log.entries.find((e) => e.kind === "snapshot")?.payload as {
      tables: { r: { key: string; value: unknown }[] };
    };
    expect(seen.tables.r.find((row) => row.key === "seen")?.value).toBeNull();
  });

  test("a rebuilt constructor that reads the alarm while one is pending is reported", async () => {
    constructorReads = true;
    try {
      const pending = await runWith("armThenReset", [1_000], { andThen: "noop" });
      expect(pending.run.unsupportedReasons.join()).toContain("constructor read the alarm");
      // Reading with nothing pending is faithful: native storage has no alarm either.
      const none = await runWith("noop", []);
      expect(none.run.unsupportedReasons).toEqual([]);
    } finally {
      constructorReads = false;
    }
  });
});
