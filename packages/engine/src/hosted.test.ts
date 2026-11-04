/**
 * An invocation hosted inside another's effect: a called Worker's code
 * running inside the call. Its effects are its own (attributed to it,
 * faulted by their position in it, turns of their own in a concurrent run),
 * a fault inside it ends it alone and the host sees what the hosting code
 * makes of that, and the host is the running invocation again afterwards.
 */
import { type AtMostOncePerKey, digestLog, type ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { replayChooser } from "./chooser.ts";
import { explore, replayRun, runOnce } from "./explore.ts";
import {
  buggyConsumer,
  checkThenInsertConsumer,
  createFakePlatform,
  type FakeHandler,
} from "./fake-platform.ts";
import { Run } from "./run.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:callee/DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};

function spec(
  messages: readonly string[],
  bounds: Partial<ScenarioSpec["bounds"]> = {},
): ScenarioSpec {
  return {
    version: 1,
    name: "fake-via-callee",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: {
      kind: "queue",
      queue: "q",
      messages: messages.map((orderId, i) => ({ id: `m${i + 1}`, body: { orderId } })),
    },
    setup: [],
    externals: [],
    invariants: [once],
    bounds: {
      maxFaultsPerRun: 1,
      maxRedeliveries: 2,
      maxConcurrentInvocations: 1,
      budgetMs: 3000,
      ...bounds,
    },
  };
}

/** Each effect entry as "invocation kind target op". */
const lines = (run: Run) =>
  run.log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);

async function once1(
  s: ScenarioSpec,
  options: Parameters<typeof createFakePlatform>[1] = {},
  faults: Parameters<typeof replayChooser>[0]["faults"] = [],
  consumer = buggyConsumer,
) {
  const platform = createFakePlatform(consumer, { viaCallee: true, ...options });
  const run = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds: s.bounds });
  await runOnce(s, platform, run);
  return { run, platform };
}

describe("an invocation hosted inside another's effect", () => {
  test("its effects are attributed to it, under the call's effect; the host is itself again afterwards", async () => {
    const { run, platform } = await once1(spec(["o-1"]));
    expect(lines(run)).toEqual([
      "m1#1 call Service:CALLEE insert",
      "m1#1/CALLEE.insert call D1:callee/DB run",
      "m1#1/CALLEE.insert result D1:callee/DB run",
      "m1#1 result Service:CALLEE insert",
      "m1#1 call Queue:q ack",
      "m1#1 result Queue:q ack",
    ]);
    expect(platform.rows.get("o-1")).toBe(1);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("a fault inside the hosted invocation crashes it alone: the host sees an error from the call, not a crash", async () => {
    const { run, platform } = await once1(spec(["o-1"]), {}, [
      {
        invocation: "m1#1/CALLEE.insert",
        ordinal: 0,
        fault: "crash_before",
        target: "D1:callee/DB",
        op: "run",
      },
    ]);
    const l = lines(run);
    // The callee never wrote; the caller's call failed with an error its code could catch, so the
    // delivery errored (the consumer did not ack) and the redelivery wrote once.
    expect(l.slice(0, 4)).toEqual([
      "m1#1 call Service:CALLEE insert",
      "m1#1/CALLEE.insert call D1:callee/DB run",
      "m1#1/CALLEE.insert fault D1:callee/DB run",
      "m1#1 result Service:CALLEE insert",
    ]);
    const failed = run.log.entries[3];
    expect(failed?.payload).toMatchObject({ result: null, error: "Error: the callee crashed" });
    expect(l.filter((x) => x.startsWith("m1#1 ")).some((x) => x.includes("ack"))).toBe(false);
    expect(l).toContain("m1#2/CALLEE.insert result D1:callee/DB run");
    expect(l).toContain("m1#2 result Queue:q ack");
    expect(platform.rows.get("o-1")).toBe(1);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("the call's own faults are a call's: ambiguous means the callee acted and the caller lost the answer", async () => {
    const { run, platform } = await once1(spec(["o-1"]), {}, [
      {
        invocation: "m1#1",
        ordinal: 0,
        fault: "ambiguous",
        target: "Service:CALLEE",
        op: "insert",
      },
    ]);
    const l = lines(run);
    expect(l.slice(0, 5)).toEqual([
      "m1#1 call Service:CALLEE insert",
      "m1#1/CALLEE.insert call D1:callee/DB run",
      "m1#1/CALLEE.insert result D1:callee/DB run",
      "m1#1 result Service:CALLEE insert",
      "m1#1 fault Service:CALLEE insert",
    ]);
    // The redelivery wrote again: the planted shape of a cross-Worker bug.
    expect(platform.rows.get("o-1")).toBe(2);
    expect(l.filter((x) => x.endsWith("result D1:callee/DB run"))).toEqual([
      "m1#1/CALLEE.insert result D1:callee/DB run",
      "m1#2/CALLEE.insert result D1:callee/DB run",
    ]);
  });

  test("a virtual timer the hosted code waits on fires: the host's settle does not hold the clock", async () => {
    const { run, platform } = await once1(spec(["o-1"], { budgetMs: 1500 }), {
      calleeSleeps: true,
    });
    expect(platform.rows.get("o-1")).toBe(1);
    expect(run.unsupportedReasons).toEqual([]);
    expect(lines(run)).toContain("m1#1/CALLEE.insert result D1:callee/DB run");
  });

  test("two calls awaited together: each callee's effects are its own, and the caller's code stays the caller's", async () => {
    const both: FakeHandler = async (message, env) => {
      await Promise.all([env.insert("o-1"), env.insert("o-2")]);
      // The caller's own effect, made after both callees answered.
      await env.count("o-1");
      message.ack();
    };
    for (const concurrent of [false, true]) {
      const platform = createFakePlatform(both, { viaCallee: true, concurrent });
      const s = spec(["x"], { maxFaultsPerRun: 0, maxConcurrentInvocations: concurrent ? 2 : 1 });
      const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: s.bounds });
      await runOnce(s, platform, run);
      const l = lines(run);
      expect(l.filter((x) => x.includes("D1:callee/DB run")).sort()).toEqual([
        "m1#1/CALLEE.insert call D1:callee/DB run",
        "m1#1/CALLEE.insert result D1:callee/DB run",
        "m1#1/CALLEE.insert#2 call D1:callee/DB run",
        "m1#1/CALLEE.insert#2 result D1:callee/DB run",
      ]);
      expect(l.filter((x) => x.includes("Service:CALLEE"))).toEqual([
        "m1#1 call Service:CALLEE insert",
        "m1#1 call Service:CALLEE insert",
        "m1#1 result Service:CALLEE insert",
        "m1#1 result Service:CALLEE insert",
      ]);
      expect(l).toContain("m1#1 result D1:DB first");
      expect(l).toContain("m1#1 result Queue:q ack");
      expect(run.unsupportedReasons).toEqual([]);
    }
  });

  test("a timer the caller set, fired while the callee waits, runs as the caller's", async () => {
    const timed: FakeHandler = async (message, env) => {
      let read: Promise<number> | undefined;
      // Due before the callee's sleep ends: the callee's settle loop fires it.
      setTimeout(() => {
        read = env.count("o-1");
      }, 10);
      await env.insert("o-1");
      await read;
      message.ack();
    };
    for (const concurrent of [false, true]) {
      const platform = createFakePlatform(timed, {
        viaCallee: true,
        calleeSleeps: true,
        concurrent,
      });
      const s = spec(["x"], { maxFaultsPerRun: 0, maxConcurrentInvocations: concurrent ? 2 : 1 });
      const run = new Run({ chooser: replayChooser({ seed: 1, faults: [] }), bounds: s.bounds });
      await runOnce(s, platform, run);
      const l = lines(run);
      expect(l).toContain("m1#1 call D1:DB first");
      expect(l.filter((x) => x.includes("/CALLEE.insert") && x.includes("D1:DB"))).toEqual([]);
      expect(l).toContain("m1#1 result Queue:q ack");
      expect(run.unsupportedReasons).toEqual([]);
    }
  });

  test("hosting outside any effect is refused", async () => {
    const run = new Run({
      chooser: replayChooser({ seed: 1, faults: [] }),
      bounds: spec([]).bounds,
    });
    await expect(run.hosted("x", async () => null)).rejects.toThrow(
      "can only be hosted inside an effect being performed",
    );
  });

  describe("in a concurrent run", () => {
    const concurrent = (options: Parameters<typeof createFakePlatform>[1] = {}) =>
      createFakePlatform(checkThenInsertConsumer, {
        concurrent: true,
        viaCallee: true,
        ...options,
      });

    test("the hosted code's effects are turns of their own, and the host is itself again afterwards", async () => {
      const s = spec(["o-1", "o-2"], { maxConcurrentInvocations: 2, maxFaultsPerRun: 0 });
      const platform = concurrent();
      const run = new Run({ chooser: replayChooser({ seed: 3, faults: [] }), bounds: s.bounds });
      await runOnce(s, platform, run);
      const l = lines(run);
      expect(l.filter((x) => x.includes("/CALLEE.insert result D1:callee/DB run"))).toEqual(
        expect.arrayContaining([
          "m1#1/CALLEE.insert result D1:callee/DB run",
          "m2#1/CALLEE.insert result D1:callee/DB run",
        ]),
      );
      expect(l).toContain("m1#1 result Queue:q ack");
      expect(l).toContain("m2#1 result Queue:q ack");
      expect(run.unsupportedReasons).toEqual([]);
    });

    test("an interleaving inside two hosted invocations is found: both callees read before either writes", async () => {
      // The caller inserts blindly; the callee checks then writes, so only a race between the two
      // callees' effects records the order twice.
      const platform = createFakePlatform(buggyConsumer, {
        concurrent: true,
        viaCallee: true,
        calleeChecks: true,
      });
      const s = spec(["o-1", "o-1"], { maxConcurrentInvocations: 2, maxFaultsPerRun: 0 });
      const verdict = await explore(s, platform, { seed: "race", now: () => 0, maxRuns: 40 });
      expect(verdict.kind).toBe("VIOLATED");
      if (verdict.kind !== "VIOLATED") return;
      expect(verdict.violation.invariant).toBe("recorded-once");
      const order = verdict.trace.entries
        .filter((e) => e.kind === "call" && e.target === "D1:callee/DB")
        .map((e) => `${e.invocation} ${e.op}`);
      const firstWrite = order.findIndex((c) => c.endsWith(" run"));
      expect(order.slice(0, firstWrite).sort()).toEqual([
        "m1#1/CALLEE.insert first",
        "m2#1/CALLEE.insert first",
      ]);
    });

    test("replay gives a byte-identical log", async () => {
      const platform = createFakePlatform(buggyConsumer, {
        concurrent: true,
        viaCallee: true,
        calleeChecks: true,
      });
      const s = spec(["o-1", "o-1"], { maxConcurrentInvocations: 2, maxFaultsPerRun: 0 });
      const verdict = await explore(s, platform, { seed: "race", now: () => 0, maxRuns: 40 });
      if (verdict.kind !== "VIOLATED") throw new Error(`expected VIOLATED, got ${verdict.kind}`);
      const again = await replayRun(s, platform, verdict.schedule);
      const twice = await replayRun(s, platform, verdict.schedule);
      expect(digestLog(again.log)).toBe(digestLog(twice.log));
      expect(lines(again)).toEqual(
        verdict.trace.entries
          .filter((e) => e.kind !== "snapshot")
          .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`),
      );
    });

    test("a fault inside a hosted invocation ends it alone while another invocation is in flight", async () => {
      const s = spec(["o-1", "o-2"], { maxConcurrentInvocations: 2 });
      const platform = concurrent();
      const run = new Run({
        chooser: replayChooser({
          seed: 3,
          faults: [
            {
              invocation: "m1#1/CALLEE.insert",
              ordinal: 0,
              fault: "crash_before",
              target: "D1:callee/DB",
              op: "run",
            },
          ],
        }),
        bounds: s.bounds,
      });
      await runOnce(s, platform, run);
      const l = lines(run);
      expect(l).toContain("m1#1/CALLEE.insert fault D1:callee/DB run");
      expect(l).toContain("m1#2/CALLEE.insert result D1:callee/DB run");
      expect(l).toContain("m2#1 result Queue:q ack");
      expect(platform.rows.get("o-1")).toBe(1);
      expect(platform.rows.get("o-2")).toBe(1);
      expect(run.unsupportedReasons).toEqual([]);
    });
  });
});
