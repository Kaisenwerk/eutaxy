/**
 * Pinned schedules: the scenario's own runs, each fault at the call it names, run before
 * exploration under each of their seeds.
 */
import {
  type AtMostOncePerKey,
  checkInvariants,
  type PinnedSchedule,
  type ScenarioSpec,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { pinnedChooser } from "./chooser.ts";
import { explore, replay } from "./explore.ts";
import { buggyConsumer, createFakePlatform } from "./fake-platform.ts";

const once: AtMostOncePerKey = {
  kind: "atMostOncePerKey",
  name: "recorded-once",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  key: "args.params.0",
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
  invariants: [once],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 10_000 },
};

const options = { seed: "pinned", maxRuns: 5, now: () => 0 } as const;

/** The scenario with these pinned schedules. */
function pinning(...pinned: PinnedSchedule[]): ScenarioSpec {
  return { ...spec, pinned };
}

const lostAnswer: PinnedSchedule = {
  name: "o-2's insert answer lost",
  faults: [{ at: { target: "D1:DB", op: "run" }, call: 2, fault: "ambiguous" }],
};

describe("pinned schedules", () => {
  test("a pinned schedule's violation is reported as it ran, named, and replays from its schedule", async () => {
    const platform = createFakePlatform(buggyConsumer);
    // Exploration alone, with no fault allowed, finds nothing.
    const quiet = { ...spec.bounds, maxFaultsPerRun: 0 };
    expect((await explore({ ...spec, bounds: quiet }, platform, options)).kind).toBe("BOUNDED");
    const verdict = await explore(
      { ...pinning(lostAnswer), bounds: quiet },
      createFakePlatform(buggyConsumer),
      options,
    );
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.pinned).toBe("o-2's insert answer lost");
    expect(verdict.violation.keys).toEqual(['"o-2"']);
    // The second insert of the run is m2's first: its invocation and ordinal, as the run had them.
    expect(verdict.schedule).toEqual({
      seed: 0,
      faults: [{ invocation: "m2#1", ordinal: 0, fault: "ambiguous", target: "D1:DB", op: "run" }],
    });
    expect(verdict.keptEvents).toEqual(["m1", "m2"]);
    expect(verdict.shrunk).toEqual({ faultsRemoved: 0, eventsRemoved: 0, runs: 0 });
    // One pinned run and its replay: exploration never started.
    expect(verdict.reached.runs).toBe(2);
    expect(verdict.assumptions).toContain(
      `pinned schedules ran before exploration, each fault at the call it names, however many faults the bounds allow a run: "o-2's insert answer lost" under seed(s) 0: ambiguous at D1:DB run, call 2`,
    );
    const again = await replay(spec, createFakePlatform(buggyConsumer), verdict.schedule);
    expect(checkInvariants(again, spec.invariants).map((v) => v.keys)).toEqual([['"o-2"']]);
  });

  test("an address on the call's arguments names the call wherever earlier faults moved it", async () => {
    // A crash before m1's insert redelivers m1 first, so o-2's insert is the run's third call.
    const verdict = await explore(
      pinning({
        name: "m1 crashes, then o-2's answer is lost",
        faults: [
          {
            at: { target: "D1:DB", op: "run", where: { "args.params.0": "o-1" } },
            fault: "crash_before",
          },
          {
            at: { target: "D1:DB", op: "run", where: { "args.params.0": "o-2" } },
            fault: "ambiguous",
          },
        ],
      }),
      createFakePlatform(buggyConsumer),
      options,
    );
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.schedule.faults.map((f) => `${f.fault} ${f.invocation}`)).toEqual([
      "crash_before m1#1",
      "ambiguous m2#1",
    ]);
  });

  test("schedules that hold leave exploration its full run cap, each seed a run", async () => {
    const fixed = () => createFakePlatform(buggyConsumer, { idempotent: true });
    const verdict = await explore(
      pinning({ ...lostAnswer, seeds: [0, 7] }, { ...lostAnswer, name: "again" }),
      fixed(),
      options,
    );
    expect(verdict.kind).toBe("BOUNDED");
    const explored = await explore(spec, fixed(), options);
    // Three pinned runs, then the same exploration (with its leak-check replays) as without them.
    expect(verdict.reached.runs).toBe(explored.reached.runs + 3);
  });

  test("a fault whose call never comes, or which its call does not allow, makes the check UNSUPPORTED", async () => {
    const cases: [PinnedSchedule, string][] = [
      [
        {
          name: "fifth insert",
          faults: [{ at: { target: "D1:DB", op: "run" }, call: 5, fault: "error" }],
        },
        'pinned schedule "fifth insert" under seed 0: fault 1 (error at D1:DB run, call 5) met no such call: the run made 2 matching call(s)',
      ],
      [
        { name: "typo", faults: [{ at: { target: "D1:BD" }, fault: "error" }] },
        'pinned schedule "typo" under seed 0: fault 1 (error at D1:BD, call 1) met no such call: the run made 0 matching call(s)',
      ],
      [
        { name: "cut off", faults: [{ at: { target: "D1:DB", op: "run" }, fault: "cut_off" }] },
        'pinned schedule "cut off" under seed 0: fault 1 (cut_off at D1:DB run, call 1) met call 1, which allows only crash_before, crash_after, ambiguous, error',
      ],
      [
        {
          name: "twice",
          faults: [
            { at: { target: "D1:DB" }, fault: "error" },
            { at: { target: "D1:DB", op: "run" }, fault: "crash_before" },
          ],
        },
        'pinned schedule "twice" under seed 0: fault 2 (crash_before at D1:DB run, call 1) met call 1, which an earlier fault of the schedule took',
      ],
    ];
    for (const [pinned, reason] of cases) {
      const verdict = await explore(pinning(pinned), createFakePlatform(buggyConsumer), options);
      expect(verdict.kind).toBe("UNSUPPORTED");
      if (verdict.kind !== "UNSUPPORTED") continue;
      expect(verdict.cause).toBe("pin_not_placed");
      expect(verdict.reason).toBe(reason);
      expect(verdict.schedule?.seed).toBe(0);
    }
  });

  test("a pinned schedule counts the calls the bounds' fault sites leave, however many faults the bounds allow", async () => {
    const onlyO2 = {
      ...spec.bounds,
      maxFaultsPerRun: 0,
      faultsAt: [{ target: "D1:DB", op: "run", where: { "args.params.0": "o-2" } }],
    };
    const first = await explore(
      {
        ...spec,
        bounds: onlyO2,
        pinned: [
          { name: "first", faults: [{ at: { target: "D1:DB", op: "run" }, fault: "ambiguous" }] },
        ],
      },
      createFakePlatform(buggyConsumer),
      options,
    );
    // m1's insert is outside the sites: the first call the address meets is o-2's.
    expect(first.kind).toBe("VIOLATED");
    if (first.kind !== "VIOLATED") return;
    expect(first.violation.keys).toEqual(['"o-2"']);
    const outside = await explore(
      {
        ...pinning({
          name: "o-1's insert",
          faults: [
            { at: { target: "D1:DB", where: { "args.params.0": "o-1" } }, fault: "ambiguous" },
          ],
        }),
        bounds: onlyO2,
      },
      createFakePlatform(buggyConsumer),
      options,
    );
    expect(outside.kind).toBe("UNSUPPORTED");
    if (outside.kind !== "UNSUPPORTED") return;
    expect(outside.reason).toMatch(/met no such call: the run made 0 matching call\(s\)$/);
  });

  test("a pinned run is a witness of the leak check: state its run left behind is found", async () => {
    let initialised = false; // survives reset(): set once, by whichever run comes first
    const leaky = createFakePlatform(
      async (message, env) => {
        const body = message.body as { orderId: string };
        if (!initialised) {
          initialised = true;
          await env.count("warm-up");
        }
        await env.insert(body.orderId);
        message.ack();
      },
      { idempotent: true },
    );
    const verdict = await explore(
      pinning({
        name: "o-2 errs",
        faults: [{ at: { target: "D1:DB", op: "run" }, call: 2, fault: "error" }],
      }),
      leaky,
      options,
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind !== "UNSUPPORTED") return;
    expect(verdict.cause).toBe("module_state_leak");
    expect(verdict.reason).toContain("warm-up");
  });

  test("pinned runs that spend the whole budget still leave exploration its first run", async () => {
    let t = 0;
    // Each reading of the clock moves it past the budget.
    const now = () => (t += 20_000);
    const sited = {
      ...pinning(lostAnswer),
      bounds: { ...spec.bounds, faultsAt: [{ target: "D1:DB", op: "run" }] },
    };
    const verdict = await explore(sited, createFakePlatform(buggyConsumer, { idempotent: true }), {
      seed: "pinned",
      maxRuns: 5,
      now,
    });
    expect(verdict.kind).toBe("BOUNDED");
    // The pinned run, exploration's first, and the leak check's replays of both.
    expect(verdict.reached.runs).toBe(4);
  });

  test("a violation in a pinned run that did not place every fault says which it did not", async () => {
    const verdict = await explore(
      pinning({
        name: "partly",
        faults: [
          { at: { target: "D1:DB", op: "run" }, call: 2, fault: "ambiguous" },
          { at: { target: "D1:DB", op: "run" }, call: 9, fault: "error" },
        ],
      }),
      createFakePlatform(buggyConsumer),
      options,
    );
    expect(verdict.kind).toBe("VIOLATED");
    if (verdict.kind !== "VIOLATED") return;
    expect(verdict.pinned).toBe("partly");
    expect(verdict.unplaced).toEqual([
      "fault 2 (error at D1:DB run, call 9) met no such call: the run made 3 matching call(s)",
    ]);
  });

  test("explore refuses pinned schedules the scenario's validation would", async () => {
    await expect(
      explore(pinning({ name: "p", faults: [] }), createFakePlatform(buggyConsumer), options),
    ).rejects.toThrow("pinned[0].faults must name at least one fault");
  });

  test("the chooser counts only the calls its address matches, and draws turns as a seeded run does", () => {
    const chooser = pinnedChooser(lostAnswer, 3);
    const at = (target: string) => [
      { label: "none", call: { target, op: "run", args: null } },
      { label: "error", call: { target, op: "run", args: null } },
      { label: "ambiguous", call: { target, op: "run", args: null } },
    ];
    expect(chooser.choose("fault", at("D1:DB"))).toBe(0);
    expect(chooser.choose("fault", at("D1:OTHER"))).toBe(0);
    expect(chooser.unplaced()).toEqual([
      "fault 1 (ambiguous at D1:DB run, call 2) met no such call: the run made 1 matching call(s)",
    ]);
    expect(chooser.choose("fault", at("D1:DB"))).toBe(2);
    expect(chooser.unplaced()).toEqual([]);
    expect(chooser.recordsTurns).toBe(false);
  });
});
