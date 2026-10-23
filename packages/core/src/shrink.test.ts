import { describe, expect, test } from "vitest";
import type { Schedule } from "./faults.ts";
import { shrinkCandidates, shrinkSize } from "./shrink.ts";

const schedule: Schedule = {
  seed: 1,
  faults: [
    { invocation: "m1#1", ordinal: 1, fault: "crash_before", target: "Queue:q", op: "ack" },
    { invocation: "m2#1", ordinal: 0, fault: "error", target: "D1:DB", op: "run" },
  ],
};

describe("shrinkCandidates", () => {
  test("offers each fault removal, then each event removal with its faults dropped", () => {
    const cands = shrinkCandidates({ schedule, keepIds: ["m1", "m2"] });
    expect(cands).toHaveLength(4);
    expect(cands[0]?.schedule.faults.map((f) => f.invocation)).toEqual(["m2#1"]);
    expect(cands[1]?.schedule.faults.map((f) => f.invocation)).toEqual(["m1#1"]);
    expect(cands[2]).toEqual({
      schedule: { seed: 1, faults: [schedule.faults[1]] },
      keepIds: ["m2"],
    });
    expect(cands[3]).toEqual({
      schedule: { seed: 1, faults: [schedule.faults[0]] },
      keepIds: ["m1"],
    });
  });

  test("never removes the last event", () => {
    const cands = shrinkCandidates({ schedule: { seed: 1, faults: [] }, keepIds: ["only"] });
    expect(cands).toEqual([]);
  });

  test("size orders by events first", () => {
    expect(shrinkSize({ schedule, keepIds: ["a"] })).toBeLessThan(
      shrinkSize({ schedule: { seed: 1, faults: [] }, keepIds: ["a", "b"] }),
    );
  });
});
