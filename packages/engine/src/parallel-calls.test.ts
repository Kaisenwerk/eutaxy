/**
 * Calls in parallel inside one invocation, one invocation at a time: a
 * handler that awaits two chains of calls together has two chains of
 * effects in flight at once, and which call's I/O lands first is real
 * time's to say. Their effects are turns, as with several invocations in
 * flight, so the order is the schedule's and the run replays.
 */
import type { AtMostOncePerKey, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { realTick } from "./clock.ts";
import { explore, replay, runPinned } from "./explore.ts";
import { createFakePlatform, type FakeHandler } from "./fake-platform.ts";
import { replayRun } from "./once.ts";
import { restrictSpec } from "./shrink.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};

const spec: ScenarioSpec = {
  version: 1,
  name: "parallel-calls",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
  setup: [],
  externals: [],
  invariants: [],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 10_000 },
};

/** Two chains awaited together, each a read then a write of its own row. */
const twoChains =
  (wrote: string[] = []): FakeHandler =>
  async (message, env) => {
    const { orderId } = message.body as { orderId: string };
    const chain = async (name: string) => {
      await env.count(orderId);
      await env.insert(`${orderId}-${name}`);
      wrote.push(name);
    };
    await Promise.all([chain("a"), chain("b")]);
    message.ack();
  };

/** Two chains awaited together, each checking for the row before writing it: correct alone, a duplicate when they interleave. */
const twoCheckers: FakeHandler = async (message, env) => {
  const { orderId } = message.body as { orderId: string };
  const chain = async () => {
    if ((await env.count(orderId)) === 0) await env.insert(orderId);
  };
  await Promise.all([chain(), chain()]);
  message.ack();
};

/**
 * Reads that take real time, where which of a run's two is the slow one
 * flips with every run, as two calls into objects land in either order.
 */
function jitter(): () => Promise<void> {
  let reads = 0;
  return async () => {
    const n = reads++;
    const firstOfRun = n % 2 === 0;
    const evenRun = Math.floor(n / 2) % 2 === 0;
    if (firstOfRun === evenRun) for (let i = 0; i < 3; i++) await realTick();
  };
}

const options = { seed: "parallel", faultProbability: 0, now: () => 0 };

describe("calls in parallel inside one invocation, one invocation at a time", () => {
  test("two chains awaited together end in a verdict, whichever call's I/O lands first", async () => {
    const platform = createFakePlatform(twoChains(), { concurrent: true, readTakes: jitter() });
    const verdict = await explore(spec, platform, { ...options, maxRuns: 4 });
    expect(verdict.kind, JSON.stringify(verdict).slice(0, 600)).toBe("BOUNDED");
    // The verdict says what it rests on: the calls were interleaved at their effects.
    expect(verdict.assumptions.join("\n")).toMatch(
      /one invocation at a time \(maxConcurrentInvocations = 1\), an object's work after its answer running to rest before the next event starts, the calls an invocation makes in parallel \(two awaited together\) interleaved only at asynchronous effects/,
    );
  });

  test("every order of the two chains' effects is run when exploring exhaustively", async () => {
    const wrote: string[] = [];
    const platform = createFakePlatform(twoChains(wrote), {
      concurrent: true,
      readTakes: jitter(),
    });
    const verdict = await explore(spec, platform, { ...options, exhaustive: true, maxRuns: 100 });
    expect(verdict.kind, JSON.stringify(verdict).slice(0, 600)).toBe("BOUNDED");
    if (verdict.kind !== "BOUNDED") return;
    expect(verdict.reached.exhaustive?.complete).toBe(true);
    // Each run's two writes, in the order they landed, past the first run (the one that showed the
    // calls, in real time's order, before the exploration started over): both orders were run.
    const orders = new Set<string>();
    for (let i = 2; i + 1 < wrote.length; i += 2) orders.add(`${wrote[i]}${wrote[i + 1]}`);
    expect([...orders].sort()).toEqual(["ab", "ba"]);
  });

  test("a bug that needs the two chains to interleave is found, shrunk and replayed", async () => {
    const platform = () =>
      createFakePlatform(twoCheckers, { concurrent: true, readTakes: jitter() });
    const racy = { ...spec, invariants: [once] };
    const verdict = await explore(racy, platform(), { ...options, exhaustive: true, maxRuns: 100 });
    expect(verdict.kind, JSON.stringify(verdict).slice(0, 600)).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("recorded-once");
    // The schedule says its run made every effect a turn, so a replay does: on a platform of its
    // own, whose reads land in another order, it gives the same trace.
    expect(verdict.schedule.effectsAsTurns).toBe(true);
    const again = await replay(
      restrictSpec(platform(), racy, verdict.keptEvents),
      platform(),
      verdict.schedule,
    );
    expect(again).toEqual(verdict.trace);
  });

  test("a schedule that does not say so is replayed with turns once its run shows the parallel calls", async () => {
    const platform = createFakePlatform(twoChains(), { concurrent: true, readTakes: jitter() });
    const run = await replayRun(spec, platform, { seed: 7, faults: [] });
    expect(run.schedule.effectsAsTurns).toBe(true);
    expect(run.parallelCalls).toBeUndefined();
  });

  test("calls that show only when a run is replayed make the check start over too", async () => {
    // One chain in the first two runs, two awaited together from the third on: the runs of the
    // exploration show nothing, the replays before BOUNDED do.
    let deliveries = 0;
    const platform = createFakePlatform(
      async (message, env) => {
        const { orderId } = message.body as { orderId: string };
        const chain = async (name: string) => {
          await env.count(orderId);
          await env.insert(`${orderId}-${name}`);
        };
        if (deliveries++ < 2) {
          await chain("a");
          await chain("b");
        } else await Promise.all([chain("a"), chain("b")]);
        message.ack();
      },
      { concurrent: true, readTakes: jitter() },
    );
    const verdict = await explore(spec, platform, { ...options, maxRuns: 2 });
    expect(verdict.kind, JSON.stringify(verdict).slice(0, 600)).toBe("BOUNDED");
    expect(verdict.assumptions.join("\n")).toContain("the calls an invocation makes in parallel");
  });

  test("a pinned schedule written from such a run says so, and its runs make every effect a turn from their start", async () => {
    const platform = createFakePlatform(twoChains(), { concurrent: true, readTakes: jitter() });
    const run = await replayRun(spec, platform, { seed: 7, faults: [] });
    const pinned = run.asPinned("as it ran");
    expect(pinned.effectsAsTurns).toBe(true);
    // A handler with one chain shows no parallel calls: the mark alone makes its effects turns.
    const plain = createFakePlatform(
      async (message, env) => {
        await env.insert((message.body as { orderId: string }).orderId);
        message.ack();
      },
      { concurrent: true },
    );
    expect((await runPinned(spec, plain, pinned)).schedule.effectsAsTurns).toBe(true);
    expect(
      (await runPinned(spec, plain, { name: "plain", faults: [] })).schedule.effectsAsTurns,
    ).toBeUndefined();
  });

  test("a handler with one chain is run as before: no effect a turn, and the schedule says nothing of turns", async () => {
    const platform = createFakePlatform(
      async (message, env) => {
        const { orderId } = message.body as { orderId: string };
        await env.count(orderId);
        await env.insert(orderId);
        message.ack();
      },
      { concurrent: true },
    );
    const run = await replayRun(spec, platform, { seed: 7, faults: [] });
    expect(run.parallelCalls).toBeUndefined();
    expect(run.schedule).toEqual({ seed: 7, faults: [] });
    const verdict = await explore(spec, platform, { ...options, maxRuns: 3 });
    expect(verdict.assumptions).toContain(
      "one invocation at a time (maxConcurrentInvocations = 1)",
    );
  });

  test("calls made together inside an effect that runs as one turn are named when a run does not replay", async () => {
    // The write reads twice at once inside its own effect, which hosts no code: no turn orders
    // the two reads, with every effect a turn or not, so the check does not start over.
    const platform = createFakePlatform(
      async (message, env) => {
        await env.insert((message.body as { orderId: string }).orderId);
        message.ack();
      },
      { concurrent: true, parallelInside: true, readTakes: jitter() },
    );
    const verdict = await explore(spec, platform, { ...options, maxRuns: 4 });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("not_replayable");
    // The reason offers the calls as what may have differed; it does not rule a leak out.
    expect(verdict.reason).toContain(
      "either state is leaking between runs (module-level variables, or a binding Eutaxy does not reset) or two calls made in parallel landed in another order",
    );
    expect(verdict.reason).toContain(
      "; the run made calls in parallel that nothing orders here, and which of them lands first is real time's to say: m1#1 made D1:DB first while its D1:DB first was in flight (they were made inside an effect that runs as one turn, as an object's are inside blockConcurrencyWhile)",
    );
    expect(verdict.assumptions).toContain(
      "one invocation at a time (maxConcurrentInvocations = 1)",
    );
  });

  test("calls turns would order decide, though a pair no turn orders was made first", async () => {
    // The write reads twice at once inside its own effect, then the handler awaits two chains.
    const platform = createFakePlatform(
      async (message, env) => {
        const { orderId } = message.body as { orderId: string };
        await env.insert(orderId);
        await Promise.all([env.count(`${orderId}-a`), env.count(`${orderId}-b`)]);
        message.ack();
      },
      { concurrent: true, parallelInside: true },
    );
    const run = await replayRun(spec, platform, { seed: 7, faults: [] });
    // Made again with every effect a turn; the pair inside the write is still nobody's to order.
    expect(run.schedule.effectsAsTurns).toBe(true);
    expect(run.parallelCalls?.turnsWouldOrder).toBe(false);
  });

  test("a schedule recorded with every effect a turn is refused where effects cannot be turns", async () => {
    const platform = createFakePlatform(twoChains());
    await expect(
      replayRun(spec, platform, { seed: 7, faults: [], effectsAsTurns: true }),
    ).rejects.toThrow(
      "the schedule was recorded with every effect a turn (effectsAsTurns), which the fake platform cannot do: it delivers one event at a time",
    );
    const pinned = { name: "as it ran", faults: [], effectsAsTurns: true } as const;
    await expect(runPinned(spec, platform, pinned)).rejects.toThrow(
      'pinned schedule "as it ran" was recorded with every effect a turn',
    );
    const verdict = await explore({ ...spec, pinned: [pinned] }, platform, {
      ...options,
      maxRuns: 2,
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("unsupported_bounds");
    expect(verdict.reason).toBe(
      'pinned schedule "as it ran" was recorded with every effect a turn (effectsAsTurns), which the fake platform cannot do: it delivers one event at a time',
    );
  });

  test("where effects cannot be turns, a run that does not replay names the parallel calls, not leaking state", async () => {
    // A platform that delivers one event at a time: the calls land in real time's order.
    const platform = createFakePlatform(twoChains(), { readTakes: jitter() });
    // Four runs, so the first two are replayed after an even number of others: the slow read flips.
    const verdict = await explore(spec, platform, { ...options, maxRuns: 4 });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("not_replayable");
    expect(verdict.reason).toContain(
      "; the run made calls in parallel that nothing orders here, and which of them lands first is real time's to say: m1#1 made D1:DB first while its D1:DB first was in flight (the fake platform delivers one event at a time)",
    );
  });
});
