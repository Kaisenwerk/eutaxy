import {
  type AtLeastOnce,
  type AtMostOncePerKey,
  digestLog,
  type Implies,
  type Platform,
  type ScenarioSpec,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { explore, replay } from "./explore.ts";
import { buggyConsumer, createFakePlatform } from "./fake-platform.ts";
import { Run } from "./run.ts";
import { restrictSpec } from "./shrink.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
};
const all: AtLeastOnce = {
  kind: "atLeastOnce",
  name: "every-recorded",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
  expected: ["o-1", "o-2"],
  perMessage: { bodyKey: "orderId" },
};

const spec: ScenarioSpec = {
  version: 1,
  name: "fake-duplicate-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: {
    kind: "queue",
    queue: "q",
    messages: [
      { id: "m1", body: { orderId: "o-1" } },
      { id: "m2", body: { orderId: "o-2" } },
    ],
  },
  setup: [],
  externals: [],
  invariants: [once, all],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 10_000 },
};

/** A clock that only moves when told to, so budgets are deterministic in tests. */
function fixedClock(): () => number {
  return () => 0;
}

describe("explore", () => {
  test("finds the duplicate write in the buggy consumer and replays it", async () => {
    const platform = createFakePlatform(buggyConsumer);
    const verdict = await explore(spec, platform, { seed: "t1", now: fixedClock() });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("recorded-once");
    expect(verdict.schedule.faults.length).toBeGreaterThan(0);
    const kinds = verdict.trace.entries.map((e) => e.kind);
    expect(kinds).toContain("fault");
    // The witness: two committed inserts for the same key, across a redelivery.
    const [a, b] = verdict.violation.evidence;
    expect(verdict.trace.entries[a as number]?.invocation).not.toBe(
      verdict.trace.entries[b as number]?.invocation,
    );
    expect(verdict.assumptions).toContain("fake in-memory platform");
    // Shrunk to the one message and the one fault that matter.
    expect(verdict.keptEvents).toHaveLength(1);
    const kept = verdict.keptEvents[0] as string;
    expect(verdict.schedule.faults).toHaveLength(1);
    expect(verdict.shrunk.eventsRemoved).toBe(1);
    expect(
      verdict.trace.entries
        .filter((e) => e.kind !== "snapshot")
        .every((e) => e.invocation.startsWith(`${kept}#`)),
    ).toBe(true);
    // Replaying the shrunk schedule on the restricted scenario reproduces the exact trace.
    const restricted = restrictSpec(platform, spec, verdict.keptEvents);
    const again = await replay(restricted, platform, verdict.schedule);
    expect(digestLog(again)).toBe(digestLog(verdict.trace));
  });

  test("the idempotent consumer is BOUNDED", async () => {
    const platform = createFakePlatform(buggyConsumer, { idempotent: true });
    const verdict = await explore(spec, platform, { seed: "t2", maxRuns: 60, now: fixedClock() });
    expect(verdict.kind).toBe("BOUNDED");
    if (verdict.kind !== "BOUNDED") return;
    expect(verdict.reached.runs).toBe(62); // 60 explored + the 2-run leak check
    expect(verdict.reached.faultsInjected).toBeGreaterThan(0);
    expect(verdict.bounds).toEqual(spec.bounds);
  });

  test("is deterministic: same seed, same verdict and trace", async () => {
    const a = await explore(spec, createFakePlatform(buggyConsumer), {
      seed: 7,
      now: fixedClock(),
    });
    const b = await explore(spec, createFakePlatform(buggyConsumer), {
      seed: 7,
      now: fixedClock(),
    });
    expect(a.kind).toBe("VIOLATED");
    if (a.kind !== "VIOLATED" || b.kind !== "VIOLATED") return;
    expect(digestLog(a.trace)).toBe(digestLog(b.trace));
    expect(a.schedule).toEqual(b.schedule);
  });

  test("a lost message (crash before the insert, retries exhausted) violates atLeastOnce", async () => {
    const tight: ScenarioSpec = {
      ...spec,
      invariants: [all],
      bounds: { ...spec.bounds, maxRedeliveries: 0 },
    };
    const verdict = await explore(tight, createFakePlatform(buggyConsumer, { idempotent: true }), {
      seed: "t4",
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("every-recorded");
  });

  test("an unsupported API makes the run UNSUPPORTED", async () => {
    const platform = createFakePlatform(async (message, env) => {
      await env.insert("x");
      message.ack();
    });
    const original = platform.deliver.bind(platform);
    platform.deliver = async (event, hooks, s) => {
      hooks.unsupported("binding KV_THING is not proxied");
      return original(event, hooks, s);
    };
    const verdict = await explore({ ...spec, invariants: [once] }, platform, {
      seed: 1,
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.cause).toBe("unsupported_api");
  });

  test("more than one concurrent invocation is UNSUPPORTED on a platform that delivers one at a time", async () => {
    const verdict = await explore(
      { ...spec, bounds: { ...spec.bounds, maxConcurrentInvocations: 2 } },
      createFakePlatform(buggyConsumer),
      { seed: 1, now: fixedClock() },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") {
      expect(verdict.cause).toBe("unsupported_bounds");
      expect(verdict.reason).toContain("fake platform");
    }
  });

  test("an effect whose real I/O never completes ends the run UNSUPPORTED within the budget", {
    timeout: 10_000,
  }, async () => {
    const verdict = await explore(
      { ...spec, bounds: { ...spec.bounds, budgetMs: 50 } },
      createFakePlatform(buggyConsumer, { hangInsert: "o-1" }),
      { seed: "hang", faultProbability: 0 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") {
      expect(verdict.cause).toBe("unsupported_api");
      expect(verdict.reason).toContain("D1:DB run did not complete within 50 ms");
    }
  });

  test("stops at the time budget", async () => {
    let t = 0;
    const now = () => (t += 100);
    const verdict = await explore(
      { ...spec, invariants: [all], bounds: { ...spec.bounds, budgetMs: 350 } },
      createFakePlatform(buggyConsumer, { idempotent: true }),
      { seed: "budget", now, faultProbability: 0 },
    );
    expect(verdict.kind).toBe("BOUNDED");
    expect(verdict.reached.runs).toBeLessThanOrEqual(6); // at most 4 within budget + the 2-run leak check
  });

  test("budgetMs replaces the scenario's budget, in either direction", async () => {
    const run = (scenarioBudget: number, budgetMs: number) => {
      let t = 0;
      return explore(
        { ...spec, invariants: [all], bounds: { ...spec.bounds, budgetMs: scenarioBudget } },
        createFakePlatform(buggyConsumer, { idempotent: true }),
        { seed: "budget", now: () => (t += 100), faultProbability: 0, maxRuns: 12, budgetMs },
      );
    };
    const shorter = await run(1_000_000, 350);
    expect(shorter.reached.runs).toBeLessThanOrEqual(6);
    const longer = await run(350, 1_000_000);
    expect(longer.reached.runs).toBeGreaterThanOrEqual(12); // the run cap, not the clock, ends it
  });

  test("budgetMs is also the time an effect's real I/O may take", { timeout: 10_000 }, async () => {
    const verdict = await explore(spec, createFakePlatform(buggyConsumer, { hangInsert: "o-1" }), {
      seed: "hang",
      faultProbability: 0,
      budgetMs: 50,
    });
    expect(verdict.kind === "UNSUPPORTED" && verdict.reason).toContain(
      "D1:DB run did not complete within 50 ms",
    );
  });

  test("budgetMs must be a positive number", async () => {
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        explore(spec, createFakePlatform(buggyConsumer), { seed: "x", budgetMs }),
      ).rejects.toThrow("budgetMs must be a positive finite number");
  });
});

describe("state invariants over the end-of-run snapshot", () => {
  test("everyRow over the snapshot catches the duplicate as a count above one", async () => {
    const onePerOrder: ScenarioSpec = {
      ...spec,
      invariants: [
        {
          kind: "everyRow",
          name: "one-row-per-order",
          query: { target: "D1:DB", table: "payments" },
          holds: [{ column: "count", op: "lte", value: 1 }],
        },
      ],
    };
    const verdict = await explore(onePerOrder, createFakePlatform(buggyConsumer), {
      seed: "rows",
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.violation.invariant).toBe("one-row-per-order");
    expect(verdict.trace.entries.at(-1)?.kind).toBe("snapshot");
  });

  test("implies ties acked messages to rows and holds for the consumer", async () => {
    const ackedHasRow: ScenarioSpec = {
      ...spec,
      invariants: [
        {
          kind: "implies",
          name: "acked-has-row",
          when: { target: "Queue:q", op: "ack", kind: "result" },
          key: "args.messageId",
          state: { target: "D1:DB", table: "payments" },
          column: "order_id",
        },
      ],
    };
    // Message ids are m1/m2 but rows are keyed by order id, so this must fail for every ack...
    const bad = await explore(ackedHasRow, createFakePlatform(buggyConsumer), {
      seed: 1,
      maxRuns: 3,
      now: fixedClock(),
    });
    expect(bad.kind).toBe("VIOLATED");
    // ...and pass once the key matches the column.
    const good: ScenarioSpec = {
      ...ackedHasRow,
      drive: { ...spec.drive, messages: [{ id: "o-1", body: { orderId: "o-1" } }] },
      invariants: [{ ...(ackedHasRow.invariants[0] as Implies), key: "args.messageId" }],
    };
    const ok = await explore(good, createFakePlatform(buggyConsumer), {
      seed: 1,
      maxRuns: 3,
      faultProbability: 0,
      now: fixedClock(),
    });
    expect(ok.kind).toBe("BOUNDED");
  });
});

describe("module-state leak detection", () => {
  test("a consumer with module-level state that changes behaviour across runs is UNSUPPORTED", async () => {
    let callsEver = 0; // survives reset(): the kind of state a Worker keeps at module scope
    const leaky = createFakePlatform(async (message, env) => {
      const body = message.body as { orderId: string };
      callsEver++;
      if (callsEver > 3) await env.insert(`${body.orderId}-late`);
      await env.insert(body.orderId);
      message.ack();
    });
    const verdict = await explore({ ...spec, invariants: [once] }, leaky, {
      seed: "leak",
      maxRuns: 3,
      faultProbability: 0,
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("module_state_leak");
    expect(verdict.reached.runs).toBeGreaterThan(3);
  });

  test("the pass can be disabled and costs nothing then", async () => {
    const verdict = await explore(
      { ...spec, invariants: [once] },
      createFakePlatform(buggyConsumer, { idempotent: true }),
      {
        seed: "noleak",
        maxRuns: 3,
        faultProbability: 0,
        leakCheckRuns: 0,
        now: fixedClock(),
      },
    );
    expect(verdict.kind).toBe("BOUNDED");
    expect(verdict.reached.runs).toBe(3);
  });

  test("a clean consumer pays the replays and stays BOUNDED", async () => {
    const verdict = await explore(
      { ...spec, invariants: [once] },
      createFakePlatform(buggyConsumer, { idempotent: true }),
      {
        seed: "clean",
        maxRuns: 3,
        faultProbability: 0,
        now: fixedClock(),
      },
    );
    expect(verdict.kind).toBe("BOUNDED");
    expect(verdict.reached.runs).toBe(5);
  });
});

describe("virtual globals during exploration", () => {
  test("Date.now and randomness in effect arguments are identical on replay", async () => {
    const stamping = createFakePlatform(async (message, env) => {
      const body = message.body as { orderId: string };
      await env.insert(`${body.orderId}@${Date.now()}:${crypto.randomUUID()}`);
      message.ack();
    });
    const verdict = await explore({ ...spec, invariants: [once] }, stamping, {
      seed: "stamp",
      now: fixedClock(),
    });
    // Keys differ per attempt because of the stamp, so the duplicate-write invariant never fires...
    expect(verdict.kind).toBe("BOUNDED");
    // ...but every run's log was replay-stable: the same seed reproduces the same stamps.
    const a = await explore({ ...spec, invariants: [once] }, stamping, {
      seed: "stamp",
      maxRuns: 2,
      now: fixedClock(),
    });
    const b = await explore({ ...spec, invariants: [once] }, stamping, {
      seed: "stamp",
      maxRuns: 2,
      now: fixedClock(),
    });
    expect(a.reached.effectPoints).toBe(b.reached.effectPoints);
    const log1 = await replay(spec, stamping, { seed: 7, faults: [] });
    const log2 = await replay(spec, stamping, { seed: 7, faults: [] });
    expect(digestLog(log1)).toBe(digestLog(log2));
    const stamp = log1.entries[0]?.payload as { args: { params: string[] } };
    expect(stamp.args.params[0]).toMatch(/^o-1@1767225600000:[0-9a-f-]{36}$/);
  });

  test("a crashed invocation's timers never fire, even while a later attempt waits on its own", async () => {
    const ran: string[] = [];
    const platform = createFakePlatform(async (message, env) => {
      const body = message.body as { orderId: string };
      setTimeout(() => ran.push(`${body.orderId}@${message.id}`), 50);
      await env.insert(body.orderId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      message.ack();
    });
    const restricted = restrictSpec(platform, spec, ["m1"]);
    // Crash the first attempt right after its insert; the retry then sleeps and acks.
    const log = await replay(restricted, platform, {
      seed: 3,
      faults: [
        { invocation: "m1#1", ordinal: 0, fault: "crash_after", target: "D1:DB", op: "run" },
      ],
    });
    expect(log.entries.some((e) => e.kind === "fault")).toBe(true);
    expect(ran).toEqual(["o-1@m1"]); // the retry's timer only; the crashed attempt's never ran
    expect(log.entries.filter((e) => e.kind === "result" && e.op === "ack")).toHaveLength(1);
  });

  test("globals are restored even when the platform throws", async () => {
    const realNow = Date.now;
    const broken = createFakePlatform(buggyConsumer);
    broken.reset = async () => {
      throw new Error("reset failed");
    };
    await expect(replay(spec, broken, { seed: 1, faults: [] })).rejects.toThrow("reset failed");
    expect(Date.now).toBe(realNow);
  });
});

describe("shrinking", () => {
  test("a lost-message violation keeps only the lost message", async () => {
    const tight: ScenarioSpec = {
      ...spec,
      invariants: [all],
      bounds: { ...spec.bounds, maxRedeliveries: 0 },
    };
    const verdict = await explore(tight, createFakePlatform(buggyConsumer, { idempotent: true }), {
      seed: "shrink-lost",
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.keptEvents).toHaveLength(1);
    // The per-message expectation was re-derived, so the surviving key is the lost one.
    const messages = spec.drive["messages"] as { id: string; body: { orderId: string } }[];
    const kept = messages.find((m) => m.id === verdict.keptEvents[0]);
    expect(verdict.violation.keys).toEqual([JSON.stringify(kept?.body.orderId)]);
  });

  test("a shrink candidate that touches an unsupported API is rejected", async () => {
    const platform = createFakePlatform(buggyConsumer);
    const original = platform.deliver.bind(platform);
    // With a single message left, the "Worker" reaches a branch that uses an unproxied binding.
    platform.deliver = async (event, hooks, s) => {
      if ((s.drive["messages"] as unknown[]).length === 1)
        hooks.unsupported("binding KV is not proxied");
      return original(event, hooks, s);
    };
    const verdict = await explore(spec, platform, {
      seed: "unsupported-shrink",
      now: fixedClock(),
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.keptEvents).toEqual(["m1", "m2"]);
    expect(verdict.shrunk.eventsRemoved).toBe(0);
  });

  test("ordinals keep a schedule valid when earlier invocations disappear", async () => {
    const platform = createFakePlatform(buggyConsumer);
    const verdict = await explore(spec, platform, {
      seed: "ordinal",
      now: fixedClock(),
      maxShrinkRuns: 0,
    });
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    const fault = verdict.schedule.faults[0];
    expect(fault?.invocation).toMatch(/^m[12]#1$/);
    // Drop the other message by hand; the same fault still fires at the same ordinal.
    const keep = fault?.invocation.split("#")[0] as string;
    const restricted = restrictSpec(platform, spec, [keep]);
    const log = await replay(restricted, platform, verdict.schedule);
    expect(log.entries.some((e) => e.kind === "fault")).toBe(true);
  });
});

describe("Run", () => {
  test("bookkeeping is one invocation per run that never becomes the running one", () => {
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: spec.bounds,
      faultProbability: 0,
    });
    run.startInvocation("i");
    const id = run.bookkeeping();
    expect(run.bookkeeping()).toBe(id);
    expect(run.running()).toBe("i");
    expect(() => run.startInvocation(id)).toThrow(/already started/);
    // The option it replaces still works: tracked, never running.
    run.startInvocation("dead-letter", { bookkeeping: true });
    expect(run.running()).toBe("i");
  });

  test("replay mode follows the schedule exactly and ignores disallowed faults", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [
          { invocation: "i", ordinal: 0, fault: "error", target: "T", op: "o" },
          { invocation: "i", ordinal: 1, fault: "ambiguous", target: "T", op: "o" },
        ],
      },
      bounds: spec.bounds,
      faultProbability: 0,
    });
    run.startInvocation("i");
    await expect(
      run.effect(
        { invocation: "i", target: "T", op: "o", args: null, allowed: ["error"] },
        async () => 1,
        (v) => v,
      ),
    ).rejects.toThrow(/injected error/);
    // ambiguous is not allowed at this point, so it is skipped and the effect succeeds.
    await expect(
      run.effect(
        { invocation: "i", target: "T", op: "o", args: null, allowed: ["error"] },
        async () => 2,
        (v) => v,
      ),
    ).resolves.toBe(2);
    expect(run.schedule.faults).toEqual([
      { invocation: "i", ordinal: 0, fault: "error", target: "T", op: "o" },
    ]);
    expect(run.log.entries.map((e) => e.kind)).toEqual(["call", "fault", "call", "result"]);
  });

  test("after a crash, further effects of that invocation hang or throw and record nothing", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [{ invocation: "i", ordinal: 0, fault: "crash_after", target: "T", op: "w" }],
      },
      bounds: spec.bounds,
      faultProbability: 0,
    });
    const inv = run.startInvocation("i");
    let performed = 0;
    const first = run.effect(
      { invocation: "i", target: "T", op: "w", args: null, allowed: ["crash_after"] },
      async () => performed++,
      () => null,
    );
    await inv.crashed;
    expect(inv.isCrashed()).toBe(true);
    expect(performed).toBe(1);
    // `first` never settles after the crash: an already-resolved competitor wins the race.
    const settled = await Promise.race([first.then(() => "settled"), Promise.resolve("hung")]);
    expect(settled).toBe("hung");
    expect(() =>
      run.effectSync(
        { invocation: "i", target: "T", op: "ack", args: null, allowed: [] },
        () => 1,
        () => null,
      ),
    ).toThrow(/crashed/);
    expect(run.log.entries).toHaveLength(3); // call, result, fault
  });

  test("an effect in flight when a cut_off lands commits but its continuation never runs", async () => {
    const run = new Run({
      mode: "replay",
      schedule: {
        seed: 1,
        faults: [{ invocation: "j", ordinal: 1, fault: "cut_off", target: "Q", op: "background" }],
      },
      bounds: spec.bounds,
      faultProbability: 0,
    });
    const j = run.startInvocation("j");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = run.effect(
      { invocation: "j", target: "D1:DB", op: "run", args: null, allowed: [] },
      async () => {
        await gate;
        return 1;
      },
      (v) => v,
    );
    expect(() =>
      run.effectSync(
        { invocation: "j", target: "Q", op: "background", args: null, allowed: ["cut_off"] },
        () => null,
        () => null,
      ),
    ).toThrow(/crashed/);
    expect(j.isCrashed()).toBe(true);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const settled = await Promise.race([inFlight.then(() => "settled"), Promise.resolve("hung")]);
    expect(settled).toBe("hung");
    expect(run.log.entries.map((e) => `${e.kind} ${e.op}`)).toEqual([
      "call run",
      "call background",
      "fault background",
      "result run",
    ]);
  });

  test("a real error from the effect is recorded as a result with the error, then rethrown", async () => {
    const run = new Run({
      mode: "replay",
      schedule: { seed: 1, faults: [] },
      bounds: spec.bounds,
      faultProbability: 0,
    });
    run.startInvocation("i");
    await expect(
      run.effect(
        { invocation: "i", target: "T", op: "w", args: null, allowed: [] },
        async () => {
          throw new Error("boom");
        },
        () => null,
      ),
    ).rejects.toThrow("boom");
    expect(run.log.entries[1]?.payload).toEqual({ args: null, result: null, error: "Error: boom" });
  });
});

describe("seeded fault placement", () => {
  /**
   * One message whose handler reads `depth - 1` times, then writes and acks.
   * The only bug is a crash right after the write (it is redelivered and
   * writes again), so a fault has to reach the depth-th eligible point.
   */
  function deepPlatform(depth: number): Platform & { faultsAt: number[] } {
    let rows = 0;
    const faultsAt: number[] = [];
    return {
      name: "deep",
      assumptions: [],
      faultsAt,
      async reset() {
        rows = 0;
      },
      initialEvents: () => [{ id: "m1", attempt: 1, data: null }],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const invocation = `${event.id}#${event.attempt}`;
        const inv = hooks.startInvocation(invocation);
        try {
          for (let i = 0; i < depth - 1; i++)
            hooks.effectSync(
              { invocation, target: "R", op: "read", args: i, allowed: ["error"] },
              () => null,
              () => null,
            );
          hooks.effectSync(
            { invocation, target: "W", op: "write", args: { key: "k" }, allowed: ["crash_after"] },
            () => ++rows,
            (n) => n,
          );
          return { status: "completed", followUps: [] };
        } catch (err) {
          if (inv.isCrashed() && event.attempt < 3)
            return { status: "crashed", followUps: [{ ...event, attempt: event.attempt + 1 }] };
          return { status: "errored", followUps: [] };
        }
      },
      async finish(_spec, hooks) {
        faultsAt.push(rows);
        hooks.snapshot(hooks.bookkeeping(), "W", { tables: { rows: [{ n: rows }] } });
      },
    };
  }
  const deepSpec: ScenarioSpec = {
    ...spec,
    name: "deep",
    invariants: [
      {
        kind: "atMostOncePerKey",
        name: "written-once",
        effect: { target: "W", op: "write", kind: "result" },
        key: "args.key",
      },
    ],
  };

  test("a fault as likely at the twentieth eligible point as at the first", async () => {
    const verdict = await explore(deepSpec, deepPlatform(20), {
      seed: "deep",
      maxRuns: 100,
      leakCheckRuns: 0,
      now: () => 0,
    });
    expect(verdict.kind).toBe("VIOLATED");
  });

  test("a run that redelivery made longer does not leave later runs without a fault", async () => {
    // Crashing the write redelivers, which doubles a run's eligible points. Every run after the
    // first still injects its fault, rather than often drawing a point it never reaches.
    const holds = await explore(
      {
        ...deepSpec,
        invariants: [
          {
            kind: "atMostOncePerKey",
            name: "reads-distinct",
            effect: { target: "none" },
            key: "k",
          },
        ],
      },
      deepPlatform(5),
      { seed: "longer", maxRuns: 60, leakCheckRuns: 0, now: () => 0 },
    );
    expect(holds.kind).toBe("BOUNDED");
    // All but the first run and the share kept fault-free (10% by default) inject their fault.
    expect(holds.reached.faultsInjected).toBeGreaterThanOrEqual(0.8 * (holds.reached.runs - 1));
  });

  test("a fault reaches deep points of a path that only some seeds take", async () => {
    // Half the seeds take a one-effect path, half a ten-effect one; the bug needs a fault at the
    // ten-effect path's last point. A first run on the short path must not hide the long one.
    let rows = 0;
    const branching: Platform = {
      name: "branching",
      assumptions: [],
      async reset() {
        rows = 0;
      },
      initialEvents: () => [{ id: "m1", attempt: 1, data: null }],
      restrictEvents: (s) => s,
      async deliver(event, hooks) {
        const invocation = `${event.id}#${event.attempt}`;
        const inv = hooks.startInvocation(invocation);
        const long = event.attempt === 1 ? Math.random() < 0.5 : true;
        try {
          for (let i = 0; i < (long ? 9 : 1); i++)
            hooks.effectSync(
              { invocation, target: "R", op: "read", args: i, allowed: ["error"] },
              () => null,
              () => null,
            );
          hooks.effectSync(
            {
              invocation,
              target: "W",
              op: "write",
              args: { key: "k" },
              allowed: long ? ["crash_after"] : [],
            },
            () => ++rows,
            (n) => n,
          );
          return { status: "completed", followUps: [] };
        } catch {
          if (inv.isCrashed() && event.attempt < 3)
            return { status: "crashed", followUps: [{ ...event, attempt: event.attempt + 1 }] };
          return { status: "errored", followUps: [] };
        }
      },
    };
    for (const seed of ["short-first-1", "short-first-2", "short-first-3"]) {
      const verdict = await explore(deepSpec, branching, {
        seed,
        maxRuns: 200,
        leakCheckRuns: 0,
        now: () => 0,
      });
      expect(verdict.kind, seed).toBe("VIOLATED");
    }
  });

  test("the first run injects no fault, and faultProbability 0 none at all", async () => {
    const first = new Set<number>();
    const platform = deepPlatform(3);
    await explore(deepSpec, platform, {
      seed: "first",
      maxRuns: 1,
      leakCheckRuns: 0,
      now: () => 0,
    });
    first.add(platform.faultsAt[0] ?? -1);
    expect([...first]).toEqual([1]);
    const none = await explore(deepSpec, deepPlatform(3), {
      seed: "none",
      maxRuns: 20,
      leakCheckRuns: 0,
      faultProbability: 0,
      now: () => 0,
    });
    expect(none.reached.faultsInjected).toBe(0);
  });
});
