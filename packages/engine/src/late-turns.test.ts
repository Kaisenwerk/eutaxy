/**
 * Late turns: an attempt the platform gave up on (`RunHooks.attempt`, a
 * Workflow step past its timeout) runs on, and in a concurrent run the
 * effects it still makes are turns that hold nothing: time passes over them
 * to the next timer when the chooser says so, so the late code's moves land
 * before, between or after what the invocation did since it gave up.
 */
import type {
  DeliveryResult,
  EventRef,
  FaultKind,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { digestLog } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { type Chooser, replayChooser, seededChooser } from "./chooser.ts";
import { realTick, virtualEpoch } from "./clock.ts";
import { runInvocation } from "./deliver.ts";
import { explore, replayRun, runOnce } from "./explore.ts";
import { Run } from "./run.ts";
import { waitLimit } from "./turns.ts";

const spec = (concurrency: number, messages = ["m1"]): ScenarioSpec => ({
  version: 1,
  name: "fake-late-attempt",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: { kind: "queue", queue: "q", messages: messages.map((id) => ({ id, body: null })) },
  setup: [],
  externals: [],
  invariants: [],
  bounds: {
    maxFaultsPerRun: 0,
    maxRedeliveries: 0,
    maxConcurrentInvocations: concurrency,
    budgetMs: 10_000,
  },
});

const none = () => null;
const effect = (
  hooks: RunHooks,
  invocation: string,
  op: string,
  performed?: () => void,
  allowed: readonly FaultKind[] = [],
) =>
  hooks.effect(
    { invocation, target: "D1:DB", op, args: null, allowed },
    async () => {
      performed?.();
      return 1;
    },
    none,
  );
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
const calls = (run: Run) =>
  run.log.entries.filter((e) => e.kind === "call").map((e) => `${e.invocation} ${e.op}`);

interface Options {
  /** The attempt's deadline; 0 means the platform gives it up at once. */
  deadlineMs?: number;
  /** The attempt's code sleeps this long (virtual) before its effect. */
  attemptSleepMs?: number;
  /** After giving up, the invocation sleeps this long before its retry effect. */
  retryDelayMs?: number;
  /** The delivery arms a heartbeat before anything else. */
  intervalMs?: number;
  /** Seen by the test: when the attempt was found late, and what the heartbeat did. */
  onLate?: (now: number) => void;
  onBeat?: () => void;
  /** Seen by the test: the virtual time at which the attempt's effect was performed. */
  onAttempt?: (now: number) => void;
  /** The attempt's effect is a call into an object, whose code makes the effect. */
  viaObject?: boolean;
  /** Inside the object, before its effect: a nap on a virtual timer of its own, or real work. */
  objectNapMs?: number;
  objectRealWork?: boolean;
  /** Seen by the test: the virtual time at which the retry's effect was performed. */
  onRetry?: (now: number) => void;
  /** The attempt's effect is made inside a timer callback (not awaited), after this many ms. */
  inTimerMs?: number;
  /** The faults the retry's effect admits. */
  retryFaults?: readonly FaultKind[];
}

/**
 * A platform whose delivery tries one effect as an attempt, gives up on it
 * at the deadline and retries after a delay, waiting for the late attempt
 * at its end as a Workflow waits for its background work.
 */
function platform(options: Options = {}): Platform {
  return {
    name: "fake",
    assumptions: [],
    concurrent: true,
    async reset() {},
    async finish() {},
    restrictEvents: (s) => s,
    initialEvents(s: ScenarioSpec): readonly EventRef[] {
      const messages = s.drive["messages"] as readonly { id: string }[];
      return messages.map((m) => ({ id: m.id, attempt: 1, data: null }));
    },
    async deliver(event: EventRef, hooks: RunHooks): Promise<DeliveryResult> {
      const invocation = `${event.id}#${event.attempt}`;
      const inv = hooks.startInvocation(invocation);
      const outcome = await runInvocation(hooks, inv, async () => {
        let beat: number | undefined;
        if (options.intervalMs !== undefined)
          beat = setInterval(() => options.onBeat?.(), options.intervalMs) as unknown as number;
        const attempt = hooks.attempt(
          invocation,
          async () => {
            if (options.attemptSleepMs !== undefined) await sleep(options.attemptSleepMs);
            if (options.inTimerMs !== undefined) {
              await new Promise<void>((resolve) => {
                setTimeout(() => {
                  void effect(hooks, invocation, "attempt", () =>
                    options.onAttempt?.(Date.now()),
                  ).then(() => resolve());
                }, options.inTimerMs);
              });
              return;
            }
            if (options.viaObject)
              await hooks.effect(
                {
                  invocation,
                  target: "DO:X",
                  op: "call",
                  args: null,
                  allowed: [],
                  hostsEffects: true,
                },
                () =>
                  hooks.hostedCode("DO:X/x", async () => {
                    if (options.objectNapMs !== undefined) await sleep(options.objectNapMs);
                    if (options.objectRealWork) for (let i = 0; i < 30; i++) await realTick();
                    await effect(hooks, hooks.running(), "attempt", () =>
                      options.onAttempt?.(Date.now()),
                    );
                    return "answered";
                  }),
                (v) => v,
                { host: "DO:X/x", onAbandon: () => {} },
              );
            else await effect(hooks, invocation, "attempt", () => options.onAttempt?.(Date.now()));
          },
          options.deadlineMs ?? 0,
        );
        const settled = attempt.value.then(() => "done" as const);
        const first = await Promise.race([settled, attempt.late.then(() => "late" as const)]);
        if (first === "late") {
          options.onLate?.(Date.now());
          await sleep(options.retryDelayMs ?? 10);
          await effect(
            hooks,
            invocation,
            "retry",
            () => options.onRetry?.(Date.now()),
            options.retryFaults,
          );
        }
        await settled;
        if (beat !== undefined) clearInterval(beat);
        return first;
      });
      return { status: outcome.status === "completed" ? "completed" : "crashed", followUps: [] };
    },
  };
}

describe("a late attempt's turns", () => {
  test("land before or after the retry, by the seed, and each order replays", async () => {
    const bySeed = new Map<string, number>();
    for (let seed = 1; seed <= 20; seed++) {
      const run = new Run({
        bounds: spec(2).bounds,
        chooser: seededChooser(seed, { faultProbability: 0, maxFaultsPerRun: 0 }),
      });
      await runOnce(spec(2), platform(), run);
      expect(run.unsupportedReasons).toEqual([]);
      const order = calls(run).join(", ");
      if (!bySeed.has(order)) bySeed.set(order, seed);
    }
    expect([...bySeed.keys()].sort()).toEqual([
      "m1#1 attempt, m1#1 retry",
      "m1#1 retry, m1#1 attempt",
    ]);
    for (const [order, seed] of bySeed) {
      const once = await replayRun(spec(2), platform(), { seed, faults: [] });
      const twice = await replayRun(spec(2), platform(), { seed, faults: [] });
      expect(digestLog(once.log)).toBe(digestLog(twice.log));
      expect(calls(once).join(", ")).toBe(order);
    }
  });

  test("exhaustive exploration runs every order: the late turn first, or time passing to the retry first", async () => {
    const seen: string[] = [];
    const verdict = await explore(
      spec(2),
      {
        ...platform(),
        async finish(_spec, hooks) {
          void hooks;
        },
      },
      { seed: 0, exhaustive: true, leakCheckRuns: 0 },
    );
    expect(verdict.kind).toBe("BOUNDED");
    // Late first; wait, then the retry's turn and the late turn in either order.
    expect(verdict.reached.exhaustive).toEqual({ complete: true, schedules: 3, reduction: true });
    void seen;
  });

  test("in a sequential run the late code runs on before the retry's delay passes", async () => {
    const lateAt: number[] = [];
    const run = new Run({
      bounds: spec(1).bounds,
      chooser: replayChooser({ seed: 1, faults: [] }),
    });
    await runOnce(spec(1), platform({ onLate: (now) => lateAt.push(now) }), run);
    expect(calls(run)).toEqual(["m1#1 attempt", "m1#1 retry"]);
    // Found late at once (the attempt's effect may have taken its millisecond first), before the delay.
    expect(lateAt).toHaveLength(1);
    expect((lateAt[0] ?? 0) - virtualEpoch).toBeLessThanOrEqual(1);
  });

  test("the deadline is measured in virtual time: an attempt still pending at it is late, one that finished is not", async () => {
    const lateAt: number[] = [];
    const slow = new Run({
      bounds: spec(1).bounds,
      chooser: replayChooser({ seed: 1, faults: [] }),
    });
    await runOnce(
      spec(1),
      platform({ deadlineMs: 50, attemptSleepMs: 100, onLate: (now) => lateAt.push(now) }),
      slow,
    );
    expect(lateAt).toEqual([virtualEpoch + 50]);
    // The retry (10 ms after the deadline) comes before the late attempt's own timer (at 100 ms).
    expect(calls(slow)).toEqual(["m1#1 retry", "m1#1 attempt"]);
    expect(slow.unsupportedReasons).toEqual([]);

    const quick = new Run({
      bounds: spec(1).bounds,
      chooser: replayChooser({ seed: 1, faults: [] }),
    });
    await runOnce(
      spec(1),
      platform({ deadlineMs: 50, attemptSleepMs: 10, onLate: (now) => lateAt.push(now) }),
      quick,
    );
    expect(lateAt).toHaveLength(1);
    expect(calls(quick)).toEqual(["m1#1 attempt"]);
    // The deadline left no timer behind and no trace.
    expect(quick.nextTimerDue()).toBeUndefined();
    expect(quick.unsupportedReasons).toEqual([]);
  });

  test("an attempt that becomes late after its effect parked holds nothing from then on: both orders appear", async () => {
    // The attempt sleeps as long as its deadline: its effect parks first (the sleep was set first), the
    // deadline is a due timer turn beside it; once it fired, time may pass over the parked effect.
    const orders = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const run = new Run({
        bounds: spec(2).bounds,
        chooser: seededChooser(seed, { faultProbability: 0, maxFaultsPerRun: 0 }),
      });
      await runOnce(spec(2), platform({ deadlineMs: 50, attemptSleepMs: 50 }), run);
      expect(run.unsupportedReasons).toEqual([]);
      orders.add(calls(run).join(", "));
    }
    // The parked effect taken before the due deadline finishes in time (no retry); the deadline taken
    // first makes the attempt late, and its effect then lands before or after the retry.
    expect([...orders].sort()).toEqual([
      "m1#1 attempt",
      "m1#1 attempt, m1#1 retry",
      "m1#1 retry, m1#1 attempt",
    ]);
  });

  test("a late attempt's effect made inside a timer callback is late too: both orders appear", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const run = new Run({
        bounds: spec(2).bounds,
        chooser: seededChooser(seed, { faultProbability: 0, maxFaultsPerRun: 0 }),
      });
      await runOnce(spec(2), platform({ inTimerMs: 10, retryDelayMs: 100 }), run);
      expect(run.unsupportedReasons).toEqual([]);
      orders.add(calls(run).join(", "));
    }
    expect([...orders].sort()).toEqual(["m1#1 attempt, m1#1 retry", "m1#1 retry, m1#1 attempt"]);
  });

  test("the deadline fires while the attempt's call is inside an object napping on a timer of its own", async () => {
    const lateAt: number[] = [];
    const run = new Run({
      bounds: spec(1).bounds,
      chooser: replayChooser({ seed: 1, faults: [] }),
    });
    run.install();
    try {
      const inv = run.startInvocation("i#1");
      const outcome = await runInvocation(run, inv, async () => {
        const attempt = run.attempt(
          "i#1",
          () =>
            run.effect(
              {
                invocation: "i#1",
                target: "DO:X",
                op: "call",
                args: null,
                allowed: [],
                hostsEffects: true,
              },
              () =>
                run.hostedCode("DO:X/x", async () => {
                  await sleep(100);
                  return "answered";
                }),
              (v) => v,
              { host: "DO:X/x" },
            ),
          50,
        );
        const first = await Promise.race([
          attempt.value.then(() => "done" as const),
          attempt.late.then(() => "late" as const),
        ]);
        lateAt.push(Date.now());
        await attempt.value;
        return first;
      });
      expect(outcome).toEqual({ status: "completed", value: "late" });
      expect(lateAt).toEqual([virtualEpoch + 50]);
      expect(run.unsupportedReasons).toEqual([]);
    } finally {
      run.uninstall();
    }
  });

  test("real work inside the attempt's call does not let the deadline fire early: the attempt is in time", async () => {
    for (const concurrency of [1, 2]) {
      const lateAt: number[] = [];
      const run = new Run({
        bounds: spec(concurrency).bounds,
        chooser: replayChooser({ seed: 1, faults: [] }),
      });
      await runOnce(
        spec(concurrency),
        platform({
          viaObject: true,
          objectRealWork: true,
          deadlineMs: 60_000,
          onLate: (now) => lateAt.push(now),
        }),
        run,
      );
      expect(lateAt).toEqual([]);
      expect(calls(run)).toEqual(["m1#1 call", "m1#1 attempt"]);
      expect(run.unsupportedReasons).toEqual([]);
    }
  });

  test("the deadline is no read of the clock: exhaustive exploration keeps its reduction", async () => {
    const verdict = await explore(spec(2, ["m1", "m2"]), platform({ deadlineMs: 1000 }), {
      seed: 0,
      exhaustive: true,
      leakCheckRuns: 0,
    });
    expect(verdict.kind).toBe("BOUNDED");
    expect(verdict.reached.exhaustive?.reduction).toBe(true);
    expect(verdict.reached.exhaustive?.complete).toBe(true);
  });

  test("a crash in the retry while the late attempt's call is inside an object hands the call to the object, which finishes it", async () => {
    // Turns: the event's start, the late call (it enters the object and its effect parks), then time
    // passes to the retry's timer, then the retry's turn, where the crash is; faults as recorded.
    const picks = [0, 0, 1, 1];
    const base = replayChooser({
      seed: 1,
      faults: [
        { invocation: "m1#1", ordinal: 1, fault: "crash_before", target: "D1:DB", op: "retry" },
      ],
    });
    const scripted: Chooser = {
      seed: base.seed,
      recordsTurns: true,
      choose: (kind, options) =>
        kind === "turn"
          ? Math.min(picks.shift() ?? 0, options.length - 1)
          : base.choose(kind, options),
    };
    const run = new Run({ bounds: spec(2).bounds, chooser: scripted });
    await runOnce(spec(2), platform({ viaObject: true, retryFaults: ["crash_before"] }), run);
    const ops = run.log.entries.map((e) => `${e.invocation} ${e.kind} ${e.op}`);
    expect(ops).toContain("m1#1 fault retry");
    // The object's effect, parked when its caller died, is the object's own and still happens.
    expect(ops).toContain("DO:X/x/after result attempt");
    expect(ops).not.toContain("m1#1 result attempt");
    expect(run.unsupportedReasons).toEqual([]);
  });

  test("time passes over late turns at most waitLimit times in one run: a heartbeat does not keep them waiting", async () => {
    let beats = 0;
    const attemptAt: number[] = [];
    // A chooser that always lets time pass when it can.
    const lastOption: Chooser = {
      seed: 1,
      recordsTurns: true,
      choose: (_kind, options) => options.length - 1,
    };
    const run = new Run({ bounds: spec(2).bounds, chooser: lastOption });
    await runOnce(
      spec(2),
      platform({
        intervalMs: 5,
        retryDelayMs: 1000,
        onBeat: () => beats++,
        onAttempt: (now) => attemptAt.push(now),
      }),
      run,
    );
    expect(run.unsupportedReasons).toEqual([]);
    // Each wait fired the heartbeat once; at the limit the late turn ran, well before the retry's delay.
    const at = (attemptAt[0] ?? 0) - virtualEpoch;
    expect(at).toBeGreaterThanOrEqual(waitLimit * 5);
    expect(at).toBeLessThan(1000);
    expect(calls(run)).toEqual(["m1#1 attempt", "m1#1 retry"]);
    expect(beats).toBeGreaterThan(waitLimit);
  });
});
