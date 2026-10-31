/**
 * The cron drive in Node: each tick is an event at its virtual time, the
 * handler sees scheduledTime and the expression, a failed tick is re-run as
 * the drive declares unless the handler said noRetry().
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce, virtualEpoch } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { atLeastOncePerMessage, cron, defineScenario } from "./scenario.ts";

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 3,
  maxConcurrentInvocations: 1,
  budgetMs: 10_000,
};

function spec(drive: ScenarioSpec["drive"]): ScenarioSpec {
  return {
    version: 1,
    name: "cron",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive,
    setup: [],
    externals: [],
    invariants: [],
    bounds,
  };
}

type Scheduled = NonNullable<WorkerHandler["scheduled"]>;

async function run(
  s: ScenarioSpec,
  scheduled: Scheduled,
  faults: Schedule["faults"] = [],
): Promise<{ log: EffectLog; run: Run }> {
  const platform = createCloudflarePlatform({ env: {}, handler: { scheduled }, schemas: {} });
  const r = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds: s.bounds });
  return { log: await runOnce(s, platform, r), run: r };
}

const ops = (log: EffectLog) =>
  log.entries.filter((e) => e.kind !== "snapshot").map((e) => `${e.invocation} ${e.kind} ${e.op}`);

describe("ticks", () => {
  test("each tick is an event at its virtual time; the handler sees scheduledTime, the expression and that time on the clock", async () => {
    const seen: [number, string, number][] = [];
    await run(spec(cron("*/5 * * * *", { ticks: 3 })), (controller) => {
      seen.push([controller.scheduledTime, controller.cron, Date.now()]);
    });
    const m = 60_000;
    expect(seen.map(([t, c]) => [t - virtualEpoch, c])).toEqual([
      [0, "*/5 * * * *"],
      [5 * m, "*/5 * * * *"],
      [10 * m, "*/5 * * * *"],
    ]);
    for (const [t, , now] of seen) expect(now).toBe(t);
  });

  test("the drive names its ticks and keeps only the named ones when restricted", () => {
    const drive = cron("0 * * * *", { ticks: 2 });
    expect(drive.ticks.map((t) => t.id)).toEqual(["tick-1", "tick-2"]);
    const platform = createCloudflarePlatform({ env: {}, handler: {}, schemas: {} });
    const kept = platform.restrictEvents(spec(drive), ["tick-2"]);
    const events = platform.initialEvents(kept);
    expect(events.map((e) => [e.id, e.at])).toEqual([["tick-2", virtualEpoch + 3_600_000]]);
    expect(events[0]?.data).toEqual({ cron: "0 * * * *", scheduledTime: virtualEpoch + 3_600_000 });
  });

  test("a Worker without a scheduled() handler cannot be driven", async () => {
    const platform = createCloudflarePlatform({ env: {}, handler: {}, schemas: {} });
    const r = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds });
    await expect(runOnce(spec(cron("* * * * *")), platform, r)).rejects.toThrow(
      "the Worker has no scheduled() handler",
    );
  });
});

describe("failures and re-runs", () => {
  test("a handler that throws is not re-run by default: the tick is given up", async () => {
    const { log } = await run(spec(cron("* * * * *")), () => {
      throw new Error("boom");
    });
    expect(ops(log)).toEqual(["platform call gave_up", "platform result gave_up"]);
    expect(log.entries[0]?.payload).toEqual({ args: { tick: "tick-1", attempts: 1 } });
    expect(log.entries[0]?.target).toBe("Cron:* * * * *");
  });

  test("with retries declared a failed tick is re-run with the same scheduledTime, then given up", async () => {
    const seen: [number, number][] = [];
    const { log } = await run(spec(cron("* * * * *", { retries: 2 })), (controller) => {
      seen.push([controller.scheduledTime, Date.now()]);
      throw new Error("boom");
    });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map(([t]) => t)).size).toBe(1);
    expect(ops(log).filter((o) => o.includes("gave_up"))).toHaveLength(2);
    expect(log.entries.find((e) => e.op === "gave_up")?.payload).toEqual({
      args: { tick: "tick-1", attempts: 3 },
    });
  });

  test("noRetry() is a decision: recorded, and no re-run follows a failure", async () => {
    let calls = 0;
    const { log } = await run(spec(cron("* * * * *", { retries: 2 })), (controller) => {
      calls++;
      controller.noRetry();
      throw new Error("boom");
    });
    expect(calls).toBe(1);
    expect(ops(log)).toEqual(["tick-1#1 call no_retry", "tick-1#1 result no_retry"]);
  });

  test("a crash before noRetry() loses the decision, so the tick is re-run", async () => {
    let calls = 0;
    const faults: Schedule["faults"] = [
      {
        invocation: "tick-1#1",
        ordinal: 0,
        fault: "crash_before",
        target: "Cron:* * * * *",
        op: "no_retry",
      },
    ];
    const { log } = await run(
      spec(cron("* * * * *", { retries: 1 })),
      (controller) => {
        calls++;
        controller.noRetry();
      },
      faults,
    );
    expect(calls).toBe(2);
    expect(ops(log)).toEqual([
      "tick-1#1 call no_retry",
      "tick-1#1 fault no_retry",
      "tick-1#2 call no_retry",
      "tick-1#2 result no_retry",
    ]);
  });

  test("a failed waitUntil is the tick's status: it is re-run as a failure would be", async () => {
    let calls = 0;
    const { log } = await run(spec(cron("* * * * *", { retries: 1 })), (_c, _env, ctx) => {
      calls++;
      ctx.waitUntil(Promise.reject(new Error("late failure")));
    });
    expect(calls).toBe(2);
    expect(ops(log)).toEqual([
      "tick-1#1 call background",
      "tick-1#1 result background",
      "tick-1#2 call background",
      "tick-1#2 result background",
      "platform call gave_up",
      "platform result gave_up",
    ]);
  });

  test("background work runs after the handler and is a point of its own", async () => {
    let done = false;
    const { log } = await run(spec(cron("* * * * *")), (_c, _env, ctx) => {
      ctx.waitUntil(
        Promise.resolve().then(() => {
          done = true;
        }),
      );
    });
    expect(done).toBe(true);
    expect(ops(log)).toEqual(["tick-1#1 call background", "tick-1#1 result background"]);
  });
});

describe("the drive in a scenario", () => {
  const base = {
    name: "s",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    invariants: [
      atLeastOncePerMessage(
        "ran",
        cron("* * * * *"),
        { target: "X", kind: "result" },
        "args.t",
        "scheduledTime",
      ),
    ],
  };

  test("defineScenario accepts a valid drive and refuses a bad expression or policy", () => {
    const ok = defineScenario({ ...base, drive: cron("*/10 * * * *", { ticks: 2, retries: 1 }) });
    expect(ok.drive).toMatchObject({ kind: "cron", cron: "*/10 * * * *", retries: 1 });
    let message = "";
    try {
      defineScenario({ ...base, drive: cron("* * * * 9", { ticks: 0, retries: -1 }) });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("cron drive: weekday: 9 is outside 1-7");
    expect(message).toContain("cron drive ticks must be a positive integer");
    expect(message).toContain("cron drive retries must be a non-negative integer");
  });

  test("atLeastOncePerMessage reads each tick's time", () => {
    const inv = atLeastOncePerMessage(
      "ran",
      cron("0 * * * *", { ticks: 2 }),
      { target: "X", kind: "result" },
      "args.t",
      "scheduledTime",
    );
    expect(inv.expected).toEqual([virtualEpoch, virtualEpoch + 3_600_000]);
  });
});
