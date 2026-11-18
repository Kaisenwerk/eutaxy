/**
 * The arithmetic of the run-cost gate (scripts/run-cost.ts): a run's cost is the time a check of
 * many runs takes beyond a check of one, and the gate holds while the ratio of the two scenarios'
 * costs stays at or under its limit. The measurement itself runs in the check job, after the suite.
 */
import { expect, test } from "vitest";
import { limit, perRun, runs, verdict } from "../scripts/run-cost.ts";

test("a run costs the time beyond a check of one run, over the runs added", () => {
  expect(runs).toBe(101);
  expect(perRun({ one: 3000, many: 9100 })).toBe(61);
  // A longer check that came out shorter is noise, not a negative cost.
  expect(perRun({ one: 3000, many: 2900 })).toBe(0);
});

test("the gate holds at its limit and fails above it", () => {
  const ordinary = { one: 1500, many: 2300 }; // 8 ms a run
  expect(verdict({ one: 3000, many: 3000 + 100 * 8 * limit }, ordinary)).toMatchObject({
    ratio: limit,
    ok: true,
  });
  expect(verdict({ one: 3000, many: 3000 + 100 * 8 * limit + 100 }, ordinary).ok).toBe(false);
  // An ordinary run that cost nothing measurable cannot vouch for anything.
  expect(verdict({ one: 3000, many: 9000 }, { one: 1500, many: 1500 }).ok).toBe(false);
});
