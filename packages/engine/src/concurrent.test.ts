import { type AtMostOncePerKey, digestLog, type ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { explore, replayRun } from "./explore.ts";
import { checkThenInsertConsumer, createFakePlatform, type FakeHandler } from "./fake-platform.ts";
import { Run } from "./run.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};

/** Two deliveries for the same order, no faults: only an interleaving can break `recorded-once`. */
function raceSpec(maxConcurrentInvocations: number): ScenarioSpec {
  return {
    version: 1,
    name: "fake-check-then-insert",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    drive: {
      kind: "queue",
      queue: "q",
      messages: [
        { id: "m1", body: { orderId: "o-1" } },
        { id: "m2", body: { orderId: "o-1" } },
      ],
    },
    setup: [],
    externals: [],
    invariants: [once],
    bounds: { maxFaultsPerRun: 0, maxRedeliveries: 2, maxConcurrentInvocations, budgetMs: 10_000 },
  };
}

const fixedClock = () => 0;
const concurrent = () => createFakePlatform(checkThenInsertConsumer, { concurrent: true });

/** The effect calls of a log as "invocation op", in log order. */
function calls(entries: readonly { kind: string; invocation: string; op: string }[]): string[] {
  return entries.filter((e) => e.kind === "call").map((e) => `${e.invocation} ${e.op}`);
}

describe("concurrent invocations", () => {
  test("check-then-insert holds one at a time", async () => {
    const verdict = await explore(raceSpec(1), concurrent(), {
      seed: "race",
      now: fixedClock,
      maxRuns: 20,
    });
    expect(verdict.kind).toBe("BOUNDED");
  });

  test("two in flight interleave the reads before the inserts and record the order twice", async () => {
    const verdict = await explore(raceSpec(2), concurrent(), {
      seed: "race",
      now: fixedClock,
      maxRuns: 20,
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("recorded-once");
    expect(verdict.schedule.faults).toEqual([]);
    const order = calls(verdict.trace.entries);
    // Both reads come before either insert: each saw no row.
    const firstInsert = order.findIndex((c) => c.endsWith(" run"));
    expect(order.slice(0, firstInsert).sort()).toEqual(["m1#1 first", "m2#1 first"]);
    expect(verdict.assumptions.some((a) => a.startsWith("up to 2 invocations in flight"))).toBe(
      true,
    );
  });

  test("replay picks the same turns, so the log is byte-identical", async () => {
    const platform = concurrent();
    const verdict = await explore(raceSpec(2), platform, {
      seed: "race",
      now: fixedClock,
      maxRuns: 20,
    });
    if (verdict.kind !== "VIOLATED") throw new Error(`expected VIOLATED, got ${verdict.kind}`);
    const again = await replayRun(raceSpec(2), platform, verdict.schedule);
    const twice = await replayRun(raceSpec(2), platform, verdict.schedule);
    expect(digestLog(again.log)).toBe(digestLog(twice.log));
    expect(calls(again.log.entries)).toEqual(calls(verdict.trace.entries));
  });

  test("real async work that is not an effect still gives the same turns on replay", async () => {
    // Hashing is real asynchronous work, not an effect, before and between the effects.
    const { subtle } = (
      globalThis as unknown as {
        crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<unknown> } };
      }
    ).crypto;
    const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    const hashing: FakeHandler = async (message, env) => {
      const body = message.body as { orderId: string };
      await subtle.digest("SHA-256", bytes(body.orderId));
      if ((await env.count(body.orderId)) === 0) {
        await subtle.digest("SHA-256", bytes(message.id));
        await env.insert(body.orderId);
      }
      message.ack();
    };
    const platform = createFakePlatform(hashing, { concurrent: true });
    const verdict = await explore(raceSpec(2), platform, {
      seed: "race",
      now: fixedClock,
      maxRuns: 50,
    });
    if (verdict.kind !== "VIOLATED") throw new Error(`expected VIOLATED, got ${verdict.kind}`);
    const digests = new Set<string>();
    for (let i = 0; i < 5; i++)
      digests.add(digestLog((await replayRun(raceSpec(2), platform, verdict.schedule)).log));
    expect(digests.size).toBe(1);
  });

  test("the same seed explores the same interleavings", async () => {
    const run = () => explore(raceSpec(2), concurrent(), { seed: 7, now: fixedClock, maxRuns: 20 });
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  test("redeliveries take a free slot and every delivery still finishes", async () => {
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: { orderId: "o-1" } },
          { id: "m2", body: { orderId: "o-2" } },
          { id: "m3", body: { orderId: "o-3" } },
        ],
      },
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 2,
        maxConcurrentInvocations: 2,
        budgetMs: 10_000,
      },
    };
    const platform = createFakePlatform(insertThenAck, { concurrent: true });
    // m2's insert crashes before it commits; its redelivery runs once a slot is free.
    const run = await replayRun(spec, platform, {
      seed: 1,
      faults: [
        { invocation: "m2#1", ordinal: 0, fault: "crash_before", target: "D1:DB", op: "run" },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect([...platform.rows.entries()].sort()).toEqual([
      ["o-1", 1],
      ["o-2", 1],
      ["o-3", 1],
    ]);
    expect(calls(run.log.entries)).toContain("m2#2 run");
  });

  test("an effect made while another is performed runs in that turn instead of deadlocking", {
    timeout: 10_000,
  }, async () => {
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: { orderId: "o-1" } },
          { id: "m2", body: { orderId: "o-2" } },
        ],
      },
    };
    const verdict = await explore(
      spec,
      createFakePlatform(insertThenAck, { concurrent: true, nestedRead: true }),
      { seed: "nested", now: fixedClock, maxRuns: 5 },
    );
    expect(verdict.kind).toBe("BOUNDED");
  });

  test("an invocation woken during another's effect still waits for its turn", async () => {
    let wake: () => void = () => {};
    let current: Promise<void> = Promise.resolve();
    // m1 inserts, and its insert wakes m2 while still in flight; m2 then reads.
    const handler: FakeHandler = async (message, env) => {
      if (message.id === "m1") await env.insert("o-1");
      else {
        await current;
        await env.count("o-2");
      }
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: {} },
          { id: "m2", body: {} },
        ],
      },
    };
    for (const [seed, insertHosts] of [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
      [n, false] as const,
      [n, true] as const,
    ])) {
      let wakeNow: () => void = () => {};
      const wokenNow = new Promise<void>((resolve) => {
        wakeNow = resolve;
      });
      wake = wakeNow;
      current = wokenNow;
      const platform = createFakePlatform(handler, {
        concurrent: true,
        duringInsert: () => wake(),
        insertHosts,
      });
      const run = await replayRun(spec, platform, { seed, faults: [] });
      const order = run.log.entries.map((e) => `${e.invocation} ${e.kind} ${e.op}`);
      // m2's read is not part of m1's insert: it comes after the insert's result.
      expect(order.indexOf("m2#1 call first"), order.join(" | ")).toBeGreaterThan(
        order.indexOf("m1#1 result run"),
      );
    }
  });

  test("an object's own effect during a call is a turn: another call can run in between", async () => {
    // Each insert checks for its row with a read made inside it (an object reading, then writing).
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const raced = (insertHosts: boolean, maxConcurrentInvocations: number) =>
      explore(
        { ...raceSpec(maxConcurrentInvocations) },
        createFakePlatform(insertThenAck, { concurrent: true, checkInside: true, insertHosts }),
        { seed: "inside", now: fixedClock, maxRuns: 50 },
      );
    // As an object's call (hosting): the second call's read runs while the first waits on its own.
    const hosted = await raced(true, 2);
    expect(hosted.kind).toBe("VIOLATED");
    // One at a time the check holds.
    expect((await raced(true, 1)).kind).toBe("BOUNDED");
  });

  test("an object awaiting two of its own effects at once still completes", {
    timeout: 10_000,
  }, async () => {
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const verdict = await explore(
      {
        ...raceSpec(2),
        drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
      },
      createFakePlatform(insertThenAck, {
        concurrent: true,
        parallelInside: true,
        insertHosts: true,
      }),
      { seed: "parallel", now: fixedClock, maxRuns: 5 },
    );
    expect(verdict.kind).toBe("BOUNDED");
  });

  test("a crash injected into a nested effect crashes the invocation, it does not hang its parent", {
    timeout: 10_000,
  }, async () => {
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 1,
        maxConcurrentInvocations: 2,
        budgetMs: 5_000,
      },
    };
    const platform = createFakePlatform(insertThenAck, { concurrent: true, nestedRead: true });
    // Ordinal 0 is the insert, ordinal 1 the read made inside it.
    const run = await replayRun(spec, platform, {
      seed: 1,
      faults: [
        { invocation: "m1#1", ordinal: 1, fault: "crash_before", target: "D1:DB", op: "first" },
      ],
    });
    expect(run.unsupportedReasons).toEqual([]);
    expect(calls(run.log.entries)).toContain("m1#2 run");
  });

  test("timers fire when every invocation is waiting on one", async () => {
    const sleepy: FakeHandler = async (message, env) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const verdict = await explore(
      {
        ...raceSpec(2),
        drive: {
          kind: "queue",
          queue: "q",
          messages: [
            { id: "m1", body: { orderId: "o-1" } },
            { id: "m2", body: { orderId: "o-2" } },
          ],
        },
      },
      createFakePlatform(sleepy, { concurrent: true }),
      { seed: "timers", now: fixedClock, maxRuns: 5 },
    );
    expect(verdict.kind).toBe("BOUNDED");
  });

  test("an effect whose real I/O never completes ends a concurrent run UNSUPPORTED", {
    timeout: 10_000,
  }, async () => {
    const insertThenAck: FakeHandler = async (message, env) => {
      await env.insert((message.body as { orderId: string }).orderId);
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "m1", body: { orderId: "o-1" } },
          { id: "m2", body: { orderId: "o-2" } },
        ],
      },
      bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 50 },
    };
    const verdict = await explore(
      spec,
      createFakePlatform(insertThenAck, { concurrent: true, hangInsert: "o-2" }),
      {
        seed: "hang",
      },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED")
      expect(verdict.reason).toContain("D1:DB run did not complete within 50 ms");
  });

  test("an invocation waiting on something Eutaxy cannot see makes the run UNSUPPORTED", async () => {
    const waitsForever: FakeHandler = async (message) => {
      if (message.id === "m2") await new Promise(() => {});
      message.ack();
    };
    const verdict = await explore(
      raceSpec(2),
      createFakePlatform(waitsForever, { concurrent: true }),
      {
        seed: "stuck",
        now: fixedClock,
        maxRuns: 5,
      },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("m2#1 is waiting");
  });
});

describe("attribution under concurrency", () => {
  test("an effect made after a promise shared between invocations is attributed to its own invocation", async () => {
    let resolveShared: () => void = () => {};
    const shared = new Promise<void>((resolve) => {
      resolveShared = resolve;
    });
    // "a" waits on state "b" settles during its own turn, then makes its effects.
    const sharing: FakeHandler = async (message, env) => {
      if (message.id === "a") {
        await shared;
        await env.insert("from-a");
      } else {
        await env.count("x");
        resolveShared();
        await env.insert("from-b");
      }
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "a", body: {} },
          { id: "b", body: {} },
        ],
      },
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = await replayRun(spec, createFakePlatform(sharing, { concurrent: true }), {
        seed,
        faults: [],
      });
      const inserts = run.log.entries
        .filter((e) => e.kind === "call" && e.op === "run")
        .map((e) => `${e.invocation} ${JSON.stringify(e.payload)}`);
      expect(inserts.find((c) => c.includes("from-a"))).toMatch(/^a#1 /);
      expect(inserts.find((c) => c.includes("from-b"))).toMatch(/^b#1 /);
    }
  });

  test("an effect made in a timer callback after a promise another timer settles stays its own", async () => {
    let resolveShared: () => void = () => {};
    const shared = new Promise<void>((resolve) => {
      resolveShared = resolve;
    });
    // "a" sets a timer whose callback waits on state that "b"'s later timer settles.
    const timers: FakeHandler = async (message, env) => {
      if (message.id === "a") {
        await new Promise<void>((done) =>
          setTimeout(async () => {
            await shared;
            await env.insert("from-a");
            done();
          }, 10),
        );
      } else {
        await new Promise<void>((done) =>
          setTimeout(() => {
            resolveShared();
            done();
          }, 20),
        );
        await env.insert("from-b");
      }
      message.ack();
    };
    const spec: ScenarioSpec = {
      ...raceSpec(2),
      drive: {
        kind: "queue",
        queue: "q",
        messages: [
          { id: "a", body: {} },
          { id: "b", body: {} },
        ],
      },
    };
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = await replayRun(spec, createFakePlatform(timers, { concurrent: true }), {
        seed,
        faults: [],
      });
      expect(run.unsupportedReasons).toEqual([]);
      const inserts = run.log.entries
        .filter((e) => e.kind === "call" && e.op === "run")
        .map((e) => `${e.invocation} ${JSON.stringify(e.payload)}`);
      expect(inserts.find((c) => c.includes("from-a"))).toMatch(/^a#1 /);
      expect(inserts.find((c) => c.includes("from-b"))).toMatch(/^b#1 /);
    }
  });
});

describe("nested effects", () => {
  test("a crash three effects deep ends every enclosing effect, without waiting for the deadline", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [{ invocation: "i#1", ordinal: 2, fault: "crash_before", target: "T", op: "c" }],
      },
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 0,
        maxConcurrentInvocations: 1,
        budgetMs: 100,
      },
      faultProbability: 0,
    });
    const inv = run.startInvocation("i#1");
    const point = (op: string) => ({
      invocation: "i#1",
      target: "T",
      op,
      args: null,
      allowed: ["crash_before" as const],
    });
    const none = () => null;
    const outer = run.effect(
      point("a"),
      () => run.effect(point("b"), () => run.effect(point("c"), async () => 1, none), none),
      none,
    );
    const settled = await Promise.race([
      outer.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(settled).toBe("pending");
    expect(inv.isCrashed()).toBe(true);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("user code cannot catch a crash injected into a nested effect and carry on", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [
          { invocation: "i#1", ordinal: 1, fault: "crash_before", target: "T", op: "inner" },
        ],
      },
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 0,
        maxConcurrentInvocations: 1,
        budgetMs: 1_000,
      },
      faultProbability: 0,
    });
    const inv = run.startInvocation("i#1");
    const point = (op: string) => ({
      invocation: "i#1",
      target: "T",
      op,
      args: null,
      allowed: ["crash_before" as const],
    });
    let continued = false;
    const outer = run.effect(
      point("outer"),
      async () => {
        try {
          await run.effect(
            point("inner"),
            async () => 1,
            () => null,
          );
        } catch {
          // A handler that swallows errors must not see the crash as one.
        }
        continued = true;
        return 2;
      },
      () => null,
    );
    const settled = await Promise.race([
      outer.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(settled).toBe("pending");
    expect(continued).toBe(false);
    expect(inv.isCrashed()).toBe(true);
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("an async context left over from a finished effect does not count as the enclosing one", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [{ invocation: "i#2", ordinal: 1, fault: "crash_after", target: "T", op: "inner" }],
      },
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 0,
        maxConcurrentInvocations: 1,
        budgetMs: 1_000,
      },
      faultProbability: 0,
    });
    const point = (invocation: string, op: string, hostsEffects = false) => ({
      invocation,
      target: "T",
      op,
      args: null,
      allowed: ["crash_after" as const],
      hostsEffects,
    });
    const none = () => null;
    // A continuation registered during a first effect's perform runs in that effect's async
    // context whenever it is resumed, as an object's code can run in the context it was built in.
    let resume: () => void = () => {};
    let work: () => Promise<unknown> = async () => undefined;
    let resumed: Promise<unknown> = Promise.resolve();
    run.startInvocation("i#1");
    await run.effect(
      point("i#1", "first"),
      async () => {
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        resumed = gate.then(() => work());
        return 1;
      },
      none,
    );
    const later = (next: () => Promise<unknown>) => {
      work = next;
      resume();
      return resumed;
    };
    // A second invocation hosts an effect whose inner effect runs in that stale context.
    let abandoned = false;
    const inv = run.startInvocation("i#2");
    const outer = run.effect(
      point("i#2", "outer", true),
      () => later(() => run.effect(point("i#2", "inner"), async () => 2, none)) as Promise<number>,
      none,
      { onAbandon: () => (abandoned = true) },
    );
    await Promise.race([outer, new Promise((resolve) => setTimeout(resolve, 200))]);
    expect(inv.isCrashed()).toBe(true);
    expect(abandoned).toBe(true);
  });

  test("a hosting effect inside another, whose own effect parks, lets the scheduler move", {
    timeout: 10_000,
  }, async () => {
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: {
        maxFaultsPerRun: 0,
        maxRedeliveries: 0,
        maxConcurrentInvocations: 2,
        budgetMs: 2_000,
      },
      faultProbability: 0,
    });
    run.install();
    try {
      const point = (op: string, hostsEffects = false) => ({
        invocation: "i#1",
        target: "T",
        op,
        args: null,
        allowed: [],
        hostsEffects,
      });
      const none = () => null;
      const started = run.startDelivery(async () => {
        run.startInvocation("i#1");
        return run.effect(
          point("outer", true),
          () =>
            run.effect(
              point("inner", true),
              () => run.effect(point("fetch"), async () => 1, none),
              none,
            ),
          none,
        );
      });
      // Drive the turns by hand: release whatever is parked until the delivery settles.
      let settled = false;
      void started.promise.then(() => (settled = true));
      for (let i = 0; i < 50 && !settled; i++) {
        await run.quiesce();
        run.takeTurn(false);
      }
      expect(settled).toBe(true);
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });
});
