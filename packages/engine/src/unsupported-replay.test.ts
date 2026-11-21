/**
 * An UNSUPPORTED verdict carries the run that reached it as a pinned schedule, each fault at the call
 * it hit (target, op, arguments, and that call's number), which `runPinned` replays to the same
 * reason after the effects before it moved, where the recorded invocation and position no longer
 * name the call.
 */
import type { AtMostOncePerKey, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { explore, runPinned } from "./explore.ts";
import { createFakePlatform, type FakeHandler } from "./fake-platform.ts";
import { replayRun } from "./once.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};

const spec: ScenarioSpec = {
  version: 1,
  name: "fake-redelivery-calls-out",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
  setup: [],
  externals: [],
  invariants: [once],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 10_000 },
};

/** A redelivery that finds its row already written calls a host the scenario does not declare. */
const consumer =
  (warmUp: boolean): FakeHandler =>
  async (message, env) => {
    const { orderId } = message.body as { orderId: string };
    if (warmUp) await env.count("warm-up");
    if ((await env.count(orderId)) > 0) await fetch("https://undeclared.example/again");
    await env.insert(orderId);
    message.ack();
  };

describe("the replay of an UNSUPPORTED run", () => {
  test("names each fault by its call, and replays to the same reason after effects before it moved", async () => {
    const verdict = await explore(spec, createFakePlatform(consumer(false), { idempotent: true }), {
      seed: "replay",
      maxRuns: 60,
      now: () => 0,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("unsupported_api");
    expect(verdict.reason).toContain("fetch to undeclared host undeclared.example");
    const fault = verdict.schedule?.faults[0];
    expect(verdict.replay).toEqual({
      name: "the run that reached UNSUPPORTED",
      faults: [
        {
          at: { target: "D1:DB", op: "run", where: { args: { sql: "INSERT", params: ["o-1"] } } },
          call: 1,
          fault: fault?.fault,
        },
      ],
      seeds: [verdict.schedule?.seed],
    });
    if (verdict.replay === undefined || verdict.schedule === undefined) return;

    const same = await runPinned(
      spec,
      createFakePlatform(consumer(false), { idempotent: true }),
      verdict.replay,
    );
    expect(same.unplaced).toEqual([]);
    expect(same.unsupportedReasons.join("; ")).toBe(verdict.reason);

    // A read added before the insert: the recorded position now names the read.
    const moved = () => createFakePlatform(consumer(true), { idempotent: true });
    const byPosition = await replayRun(spec, moved(), verdict.schedule);
    expect(byPosition.unsupportedReasons).toEqual([]);
    const byCall = await runPinned(spec, moved(), verdict.replay);
    expect(byCall.unplaced).toEqual([]);
    expect(byCall.unsupportedReasons.join("; ")).toBe(verdict.reason);
  });

  test("a call's number counts only the calls with the same target, op and arguments", async () => {
    // Two messages: o-2's insert comes second in the run, and is the first insert of o-2.
    const two: ScenarioSpec = {
      ...spec,
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: { orderId: "o-1" } },
          { id: "m2", body: { orderId: "o-2" } },
        ],
      },
      pinned: [
        {
          name: "o-2's insert answer lost",
          faults: [
            {
              at: { target: "D1:DB", op: "run", where: { "args.params.0": "o-2" } },
              fault: "crash_after",
            },
          ],
        },
      ],
    };
    const verdict = await explore(two, createFakePlatform(consumer(false), { idempotent: true }), {
      seed: "replay",
      maxRuns: 1,
      now: () => 0,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.replay?.faults).toEqual([
      {
        at: { target: "D1:DB", op: "run", where: { args: { sql: "INSERT", params: ["o-2"] } } },
        call: 1,
        fault: "crash_after",
      },
    ]);
  });
});

describe("what the replay addresses, and when there is none", () => {
  test("two faults on the same call made twice are its first and second", async () => {
    // A redelivered message inserts again with the same arguments: the second insert is call 2.
    const twice: ScenarioSpec = {
      ...spec,
      invariants: [once],
      pinned: [
        {
          name: "both inserts fail",
          faults: [
            { at: { target: "D1:DB", op: "run" }, fault: "crash_before" },
            { at: { target: "D1:DB", op: "run" }, call: 2, fault: "crash_after" },
          ],
        },
      ],
    };
    const verdict = await explore(
      twice,
      createFakePlatform(consumer(false), { idempotent: true }),
      {
        seed: "replay",
        maxRuns: 1,
        now: () => 0,
      },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED" || verdict.replay === undefined) return;
    expect(verdict.replay.faults.map((f) => `${f.fault} ${f.call}`)).toEqual([
      "crash_before 1",
      "crash_after 2",
    ]);
    const again = await runPinned(
      twice,
      createFakePlatform(consumer(false), { idempotent: true }),
      verdict.replay,
    );
    expect(again.unplaced).toEqual([]);
    expect(again.unsupportedReasons.join("; ")).toBe(verdict.reason);
  });

  test("a run exhaustive exploration picked keeps its turns, and replays by them", async () => {
    const concurrent: ScenarioSpec = {
      ...spec,
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: { orderId: "o-1" } },
          { id: "m2", body: { orderId: "o-1" } },
        ],
      },
      bounds: { ...spec.bounds, maxConcurrentInvocations: 2, maxFaultsPerRun: 0 },
    };
    // Two messages for one order in flight together: whichever reads after the other's insert calls out.
    const platform = () =>
      createFakePlatform(consumer(false), { idempotent: true, concurrent: true });
    const verdict = await explore(concurrent, platform(), {
      seed: "replay",
      exhaustive: true,
      now: () => 0,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED" || verdict.replay === undefined) return;
    expect(verdict.replay.turns).toEqual(verdict.schedule?.turns);
    expect(verdict.replay.turns?.length).toBeGreaterThan(0);
    const again = await runPinned(concurrent, platform(), verdict.replay);
    expect(again.unsupportedReasons.join("; ")).toBe(verdict.reason);
    expect(again.schedule.turns).toEqual(verdict.schedule?.turns);
  });

  test("a run whose replay alone met something outside the model carries no replay", async () => {
    let callsEver = 0; // survives reset: the leak check's replays see what the first runs did not
    const leaky: FakeHandler = async (message, env) => {
      const { orderId } = message.body as { orderId: string };
      callsEver++;
      if (callsEver > 3) await fetch("https://undeclared.example/late");
      await env.insert(orderId);
      message.ack();
    };
    const verdict = await explore(spec, createFakePlatform(leaky, { idempotent: true }), {
      seed: "leak",
      maxRuns: 3,
      faultProbability: 0,
      now: () => 0,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.schedule).toBeDefined();
    expect(verdict.replay).toBeUndefined();
  });

  test("a run that met it only after what earlier runs left behind carries no replay", async () => {
    let calls = 0; // survives reset: only the second run of the exploration calls out
    const second: FakeHandler = async (message, env) => {
      const { orderId } = message.body as { orderId: string };
      if (++calls === 2) await fetch("https://undeclared.example/second");
      await env.insert(orderId);
      message.ack();
    };
    const verdict = await explore(spec, createFakePlatform(second, { idempotent: true }), {
      seed: "state",
      maxRuns: 5,
      faultProbability: 0,
      now: () => 0,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("unsupported_api");
    expect(verdict.schedule).toBeDefined();
    // Replayed alone, the run does not call out: a test written from it would fail at once.
    expect(verdict.replay).toBeUndefined();
  });

  test("only a run that met something outside the model carries a replay", async () => {
    const verdict = await explore(
      {
        ...spec,
        pinned: [{ name: "nowhere", faults: [{ at: { target: "D1:BD" }, fault: "error" }] }],
      },
      createFakePlatform(consumer(false), { idempotent: true }),
      { seed: "replay", maxRuns: 1, now: () => 0 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("pin_not_placed");
    expect(verdict.schedule).toBeDefined();
    expect(verdict.replay).toBeUndefined();
  });

  test("runPinned refuses a schedule explore would", async () => {
    await expect(
      runPinned(spec, createFakePlatform(consumer(false)), {
        name: "bad",
        faults: [{ at: { target: "D1:DB" }, fault: "error" }],
        turns: [-1],
      }),
    ).rejects.toThrow("pinned[0].turns: -1 is not a turn (an index from 0)");
  });
});
