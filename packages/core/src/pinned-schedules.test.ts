import { describe, expect, test } from "vitest";
import {
  describePinnedFault,
  type PinnedSchedule,
  pinnedSeeds,
  validatePinnedSchedules,
} from "./pinned-schedules.ts";
import { defaultBounds, type ScenarioSpec, validateScenario } from "./scenario.ts";

const lateAttempts: PinnedSchedule = {
  name: "every attempt times out",
  faults: [1, 2, 3].map((attempt) => ({
    at: {
      target: "Workflow:TURNS",
      op: "step",
      where: { "args.step": "start turn", "args.attempt": attempt },
    },
    fault: "ambiguous" as const,
  })),
  seeds: [0, 1, 2],
};

describe("validatePinnedSchedules", () => {
  test("accepts schedules addressed by a step's name and attempt, or a call's number", () => {
    expect(
      validatePinnedSchedules([
        lateAttempts,
        {
          name: "second insert errs",
          faults: [{ at: { target: "D1:DB", op: "run" }, call: 2, fault: "error" }],
        },
      ]),
    ).toEqual([]);
  });

  test("names every problem with where it sits", () => {
    expect(
      validatePinnedSchedules([
        { name: "", faults: [] },
        {
          name: "a",
          faults: [
            { at: { target: "", where: { step: "s" } }, fault: "timeout" as never, call: 0 },
            { at: { target: "D1:DB", faults: ["error"] }, fault: "error" },
          ],
          seeds: [-1, 1.5, 2 ** 32],
          turns: [0, -1],
        },
        { name: "a", faults: [{ at: { target: "D1:DB" }, fault: "error" }], seeds: [] },
      ]),
    ).toEqual([
      "pinned[0] needs a name",
      "pinned[1].faults[0].at needs a target",
      'pinned[1].faults[0].at.where: "step" is not a path into the call\'s arguments; a site matches the call, so its paths start with "args."',
      'pinned[1].faults[0].fault: "timeout" is not a fault kind (crash_before, crash_after, ambiguous, error, cut_off)',
      "pinned[1].faults[0].call counts from 1, got 0",
      "pinned[1].faults[1].at.faults: a pinned fault names its one kind in fault; leave it out",
      "pinned[1].seeds: -1 is not a run seed (an integer, 0 to 2^32 - 1)",
      "pinned[1].seeds: 1.5 is not a run seed (an integer, 0 to 2^32 - 1)",
      "pinned[1].seeds: 4294967296 is not a run seed (an integer, 0 to 2^32 - 1)",
      "pinned[1].turns: -1 is not a turn (an index from 0)",
      'duplicate pinned schedule "a"',
      "pinned[2].seeds must name at least one seed; leave it out for seed 0",
    ]);
    expect(validatePinnedSchedules([])).toEqual([
      "pinned must name at least one schedule; leave it out for none",
    ]);
  });

  test("a scenario's validation includes its pinned schedules", () => {
    const spec: ScenarioSpec = {
      version: 1,
      name: "s",
      worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue" },
      setup: [],
      externals: [],
      invariants: [
        { kind: "atLeastOnce", name: "i", effect: { target: "D1:DB" }, key: "args", expected: [] },
      ],
      bounds: defaultBounds,
      pinned: [{ name: "p", faults: [], seeds: [] }],
    };
    expect(validateScenario(spec)).toEqual([
      "pinned[0].seeds must name at least one seed; leave it out for seed 0",
    ]);
  });
});

test("describePinnedFault names the kind, the calls it may hit and which of them", () => {
  expect(lateAttempts.faults.map(describePinnedFault)[1]).toBe(
    'ambiguous at Workflow:TURNS step where {"args.attempt":2,"args.step":"start turn"}, call 1',
  );
  expect(
    describePinnedFault({
      at: { target: "D1:DB", atLeast: { "args.n": 2 } },
      call: 3,
      fault: "error",
    }),
  ).toBe('error at D1:DB at least {"args.n":2}, call 3');
});

test("a pinned schedule runs under seed 0 unless it lists seeds", () => {
  expect(pinnedSeeds({ name: "p", faults: [] })).toEqual([0]);
  expect(pinnedSeeds(lateAttempts)).toEqual([0, 1, 2]);
});
