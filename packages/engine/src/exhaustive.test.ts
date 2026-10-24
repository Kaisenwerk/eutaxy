/**
 * The exhaustive enumerator against closed-form counts (the v0.5 gate), on a
 * synthetic platform whose shape is known exactly: k events, each delivered
 * to an invocation that makes n effects one after another; the faults on
 * offer (error, ambiguous) are caught by the handler, so they never change
 * which effects happen.
 *
 * Interleavings: each invocation is a chain of n + 1 turns (its start, then
 * one turn per effect) and events start in order, so the k chains interleave
 * in (k(n+1))! / ((n+1)!^k k!) ways. Faults: with at most m faults per run
 * and f kinds at each of the kn effect points, there are sum_{j<=m} C(kn, j) f^j
 * ways to place them. Both are independent of each other, so the schedule
 * count is their product.
 */
import type {
  DeliveryResult,
  EventRef,
  FaultKind,
  Invariant,
  JsonValue,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { virtualEpoch } from "./clock.ts";
import { explore, replayRun } from "./explore.ts";
import { buggyConsumer, checkThenInsertConsumer, createFakePlatform } from "./fake-platform.ts";
import { InjectedEffectError } from "./run.ts";

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
const choose = (n: number, k: number): number => factorial(n) / (factorial(k) * factorial(n - k));

/** Orders of k chains of n + 1 turns whose first turns come in a fixed order. */
const interleavings = (k: number, n: number): number =>
  factorial(k * (n + 1)) / (factorial(n + 1) ** k * factorial(k));

/** Ways to place at most m faults of f kinds on p effect points. */
const placements = (p: number, m: number, f: number): number => {
  let total = 0;
  for (let j = 0; j <= Math.min(m, p); j++) total += choose(p, j) * f ** j;
  return total;
};

/**
 * k events of n effects each. With `sameTarget` every effect touches one
 * target, else each invocation has its own.
 */
function stepsPlatform(faults: readonly FaultKind[], sameTarget: boolean): Platform {
  return {
    name: "steps",
    assumptions: [],
    concurrent: true,
    async reset() {},
    restrictEvents: (spec) => spec,
    initialEvents: (spec) => {
      const k = Number(spec.drive["events"]);
      return Array.from({ length: k }, (_, i) => ({ id: `e${i + 1}`, attempt: 1, data: null }));
    },
    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const invocation = `${event.id}#${event.attempt}`;
      const inv = hooks.startInvocation(invocation);
      const n = Number(spec.drive["steps"]);
      const work = (async () => {
        for (let i = 0; i < n; i++) {
          try {
            await hooks.effect(
              {
                invocation,
                target: sameTarget ? "T" : `T:${event.id}`,
                op: "step",
                args: { i },
                allowed: faults,
              },
              async () => i,
              (v) => v,
            );
          } catch (err) {
            // Faults on offer never change which effects come next.
            if (!(err instanceof InjectedEffectError)) throw err;
          }
        }
      })();
      await Promise.race([hooks.settle(work, invocation), inv.crashed]);
      return { status: "completed", followUps: [] };
    },
  };
}

const holds: Invariant = {
  kind: "atLeastOnce",
  name: "nothing",
  effect: { target: "none" },
  key: "args.i",
  expected: [],
};

function spec(k: number, n: number, m: number): ScenarioSpec {
  return {
    version: 1,
    name: "steps",
    worker: { entry: "./w.ts", config: "./w.jsonc" },
    drive: { kind: "steps", events: k, steps: n },
    setup: [],
    externals: [],
    invariants: [holds],
    bounds: {
      maxFaultsPerRun: m,
      maxRedeliveries: 0,
      maxConcurrentInvocations: k,
      budgetMs: 60_000,
    },
  };
}

async function schedules(
  k: number,
  n: number,
  m: number,
  faults: readonly FaultKind[],
  options: { reduction?: boolean; sameTarget?: boolean } = {},
): Promise<number> {
  const verdict = await explore(spec(k, n, m), stepsPlatform(faults, options.sameTarget ?? false), {
    seed: 0,
    exhaustive: { reduction: options.reduction ?? false },
    maxRuns: 100_000,
    leakCheckRuns: 0,
  });
  expect(verdict.kind).toBe("BOUNDED");
  expect(verdict.reached.exhaustive?.complete).toBe(true);
  return verdict.reached.exhaustive?.schedules ?? -1;
}

describe("exhaustive enumeration matches its closed-form count", () => {
  test.each([
    [2, 1],
    [2, 2],
    [2, 3],
    [3, 1],
    [3, 2],
  ])("interleavings of %i invocations of %i effects", async (k, n) => {
    expect(await schedules(k, n, 0, [])).toBe(interleavings(k, n));
  });

  test.each([
    [3, 1, 2],
    [3, 2, 2],
    [4, 2, 1],
  ])(
    "fault placements on one invocation of %i effects, at most %i faults of %i kinds",
    async (n, m, f) => {
      const kinds = (["error", "ambiguous"] as const).slice(0, f);
      expect(await schedules(1, n, m, kinds)).toBe(placements(n, m, f));
    },
  );

  test.each([
    [2, 2, 1, 1],
    [2, 1, 2, 2],
    [3, 1, 1, 1],
  ])("interleavings times fault placements: k=%i n=%i m=%i f=%i", async (k, n, m, f) => {
    const kinds = (["error", "ambiguous"] as const).slice(0, f);
    expect(await schedules(k, n, m, kinds)).toBe(interleavings(k, n) * placements(k * n, m, f));
  });
});

describe("partial-order reduction", () => {
  test.each([1, 2, 3])(
    "two invocations on their own targets: one order per place the second can start (n=%i)",
    async (n) => {
      // Their effects commute; only when the second starts, relative to the first's turns, matters.
      expect(await schedules(2, n, 0, [], { reduction: true })).toBe(n + 1);
      expect(await schedules(2, n, 0, [])).toBe(interleavings(2, n));
    },
  );

  test("invocations on one target do not commute: every order is still run", async () => {
    expect(await schedules(2, 2, 0, [], { reduction: true, sameTarget: true })).toBe(
      interleavings(2, 2),
    );
  });

  test("faults are still placed everywhere under the reduction", async () => {
    // One invocation: nothing to reorder, so the count is the fault placements alone.
    expect(await schedules(1, 3, 1, ["error"], { reduction: true })).toBe(placements(3, 1, 1));
  });

  test.each([
    [1, 1, 1],
    [2, 1, 1],
    [1, 2, 2],
  ])(
    "orders that repeat an explored one are counted once, faults included (n=%i m=%i f=%i)",
    async (n, m, f) => {
      // Each fault placement holds across commuting orders, so the classes multiply.
      const kinds = (["error", "ambiguous"] as const).slice(0, f);
      expect(await schedules(2, n, m, kinds, { reduction: true })).toBe(
        (n + 1) * placements(2 * n, m, f),
      );
    },
  );

  /** Two invocations, each run by `script`; the invariant fails on two effects on "Late". */
  const late: Invariant = {
    kind: "atMostOncePerKey",
    name: "late-once",
    effect: { target: "Late" },
    key: "args.k",
  };
  type Script = (
    id: string,
    step: (target: string, perform?: () => Promise<unknown>) => Promise<unknown>,
    write: (target: string, value: string) => unknown,
  ) => Promise<void | EventRef[]>;
  const scripted = (script: Script, reset: () => void = () => {}): Platform => ({
    ...stepsPlatform([], false),
    async reset() {
      reset();
    },
    async deliver(event: EventRef, hooks: RunHooks): Promise<DeliveryResult> {
      const invocation = `${event.id}#${event.attempt}`;
      const inv = hooks.startInvocation(invocation);
      const point = (target: string) => ({
        invocation,
        target,
        op: "step",
        args: { k: 1 },
        allowed: [],
      });
      const step = (target: string, perform: () => Promise<unknown> = async () => null) =>
        hooks.effect(point(target), perform, (v) => (v === undefined ? null : (v as JsonValue)));
      const write = (target: string, value: string) =>
        hooks.effectSync(
          point(target),
          () => {
            const before = shared;
            shared = value;
            return before;
          },
          (v) => v,
        );
      const work = script(event.id, step, write);
      const followUps = await Promise.race([hooks.settle(work, invocation), inv.crashed]);
      return { status: "completed", followUps: Array.isArray(followUps) ? followUps : [] };
    },
  });
  let shared = "";
  const exhaustively = (platform: Platform, maxRuns?: number) =>
    explore({ ...spec(2, 1, 0), invariants: [late] }, platform, {
      seed: 0,
      exhaustive: true,
      leakCheckRuns: 0,
      ...(maxRuns === undefined ? {} : { maxRuns }),
    });

  test("code that reads virtual time between turns turns the reduction off", async () => {
    // e1 reads the clock after its effect: it is late only when e2's effect completed first.
    const verdict = await exhaustively(
      scripted(async (id, step) => {
        await step(`T:${id}`);
        if (id === "e1" && Date.now() >= virtualEpoch + 2) {
          await step("Late");
          await step("Late");
        }
      }),
    );
    expect(verdict.kind).toBe("VIOLATED");
    expect(verdict.reached.exhaustive?.reduction).toBe(false);
  });

  test("a turn whose code touches another target turns the reduction off", async () => {
    // Different targets where the turns park, then a synchronous write to one shared target:
    // e1 goes wrong only when e2 wrote first.
    const verdict = await exhaustively(
      scripted(
        async (id, step, write) => {
          await step(`T:${id}`);
          if (write("S", id) === "e2" && id === "e1") {
            await step("Late");
            await step("Late");
          }
        },
        () => {
          shared = "";
        },
      ),
    );
    expect(verdict.kind).toBe("VIOLATED");
    expect(verdict.reached.exhaustive?.reduction).toBe(false);
  });

  test("an effect that reads virtual time turns the reduction off", async () => {
    // e1's effect itself reads the clock: it sees a later time only when e2's effect completed first.
    const verdict = await exhaustively(
      scripted(async (id, step) => {
        const at = await step(`T:${id}`, async () => Date.now());
        if (id === "e1" && at !== virtualEpoch) {
          await step("Late");
          await step("Late");
        }
      }),
    );
    expect(verdict.kind).toBe("VIOLATED");
    expect(verdict.reached.exhaustive?.reduction).toBe(false);
  });

  test("a turn that queues an event turns the reduction off", async () => {
    // Each parent's follow-up queues when it finishes: c1 goes wrong only when c2 started first.
    const verdict = await exhaustively(
      scripted(
        async (id, step, write) => {
          if (id.startsWith("c")) {
            if (write("S", id) === "c2" && id === "c1") {
              await step("Late");
              await step("Late");
            }
            return;
          }
          await step(`T:${id}`);
          return [{ id: `c${id.slice(1)}`, attempt: 1, data: null }];
        },
        () => {
          shared = "";
        },
      ),
    );
    expect(verdict.kind).toBe("VIOLATED");
    expect(verdict.reached.exhaustive?.reduction).toBe(false);
  });

  test("the run that turns the reduction off is still checked", async () => {
    // Every run is a violation; the first one is also the run that turns the reduction off.
    const verdict = await exhaustively(
      scripted(async (id, step) => {
        await step(`T:${id}`);
        Date.now();
        if (id === "e1") {
          await step("Late");
          await step("Late");
        }
      }),
      1,
    );
    expect(verdict.kind).toBe("VIOLATED");
  });
});

describe("exhaustive exploration finds what seeded exploration finds", () => {
  const recordedOnce = {
    kind: "atMostOncePerKey" as const,
    name: "recorded-once",
    effect: {
      target: "D1:DB",
      op: "run",
      kind: "result" as const,
      atLeast: { "result.changes": 1 },
    },
    key: "args.params.0",
  };
  const queueSpec = (maxConcurrentInvocations: number, maxFaultsPerRun: number): ScenarioSpec => ({
    version: 1,
    name: "fake",
    worker: { entry: "./w.ts", config: "./w.jsonc" },
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
    invariants: [recordedOnce],
    bounds: { maxFaultsPerRun, maxRedeliveries: 1, maxConcurrentInvocations, budgetMs: 60_000 },
  });

  test.each([true, false])(
    "the check-then-insert race, with reduction %s, and its schedule replays with its turns",
    async (reduction) => {
      const platform = createFakePlatform(checkThenInsertConsumer, { concurrent: true });
      const spec = queueSpec(2, 0);
      const verdict = await explore(spec, platform, {
        seed: 0,
        exhaustive: { reduction },
        leakCheckRuns: 0,
      });
      expect(verdict.kind).toBe("VIOLATED");
      if (verdict.kind !== "VIOLATED") return;
      expect(verdict.schedule.turns?.length).toBeGreaterThan(0);
      const again = await replayRun(spec, platform, verdict.schedule);
      expect(again.log.entries.map((e) => e.op)).toEqual(verdict.trace.entries.map((e) => e.op));
    },
  );

  test("the duplicate write after a crash, one invocation at a time", async () => {
    const verdict = await explore(
      {
        ...queueSpec(1, 1),
        drive: { kind: "queue", queue: "q", messages: [{ id: "m1", body: { orderId: "o-1" } }] },
      },
      createFakePlatform(buggyConsumer),
      { seed: 0, exhaustive: true, leakCheckRuns: 0 },
    );
    expect(verdict.kind).toBe("VIOLATED");
  });

  test("a correct consumer is BOUNDED with every schedule run", async () => {
    const verdict = await explore(
      queueSpec(2, 1),
      createFakePlatform(buggyConsumer, { idempotent: true, concurrent: true }),
      {
        seed: 0,
        exhaustive: true,
        leakCheckRuns: 0,
      },
    );
    expect(verdict.kind).toBe("BOUNDED");
    expect(verdict.reached.exhaustive?.complete).toBe(true);
    expect(verdict.reached.exhaustive?.schedules).toBeGreaterThan(1);
  });
});
