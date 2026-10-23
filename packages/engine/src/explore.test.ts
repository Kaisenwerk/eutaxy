import {
  type AtLeastOnce,
  type AtMostOncePerKey,
  digestLog,
  type Implies,
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
    expect(verdict.keptEvents).toEqual(["m1"]);
    expect(verdict.schedule.faults).toHaveLength(1);
    expect(verdict.shrunk.eventsRemoved).toBe(1);
    expect(
      verdict.trace.entries
        .filter((e) => e.kind !== "snapshot")
        .every((e) => e.invocation.startsWith("m1#")),
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
