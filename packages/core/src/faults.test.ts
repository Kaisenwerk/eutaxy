import { describe, expect, test } from "vitest";
import {
  decideFault,
  decisionFaults,
  type FaultKind,
  planFaults,
  readFaults,
  writeFaults,
} from "./faults.ts";

const allFaults: readonly FaultKind[] = [
  "crash_before",
  "crash_after",
  "ambiguous",
  "error",
  "cut_off",
];

import { seedPrng } from "./prng.ts";

describe("fault ladders", () => {
  test("each kind's ladder is a subset of the model in its order; cut_off belongs to the background point alone", () => {
    expect(writeFaults).toEqual(["crash_before", "crash_after", "ambiguous", "error"]);
    expect(readFaults).toEqual(writeFaults.filter((f) => f !== "ambiguous"));
    expect(decisionFaults).toEqual(["crash_before", "crash_after"]);
    for (const ladder of [writeFaults, readFaults, decisionFaults]) {
      expect(ladder).not.toContain("cut_off");
      expect([...ladder].sort()).toEqual([...new Set(ladder)].sort());
      expect(allFaults.filter((f) => ladder.includes(f))).toEqual(ladder);
    }
  });
});

describe("decideFault", () => {
  test("never injects when nothing is allowed or the budget is spent, and leaves the state alone", () => {
    const s = seedPrng(1);
    expect(decideFault(s, [], 0, { maxFaultsPerRun: 1, faultProbability: 1 })).toEqual([null, s]);
    expect(decideFault(s, allFaults, 1, { maxFaultsPerRun: 1, faultProbability: 1 })).toEqual([
      null,
      s,
    ]);
  });

  test("lists every fault kind, cut_off last", () => {
    expect(allFaults).toEqual(["crash_before", "crash_after", "ambiguous", "error", "cut_off"]);
  });

  test("always injects at probability 1 and only from the allowed list", () => {
    let s = seedPrng(2);
    for (let i = 0; i < 100; i++) {
      const [f, next] = decideFault(s, ["error", "crash_after"], 0, {
        maxFaultsPerRun: 5,
        faultProbability: 1,
      });
      expect(["error", "crash_after"]).toContain(f);
      s = next;
    }
  });

  test("never injects at probability 0 but still consumes state", () => {
    const s = seedPrng(3);
    const [f, next] = decideFault(s, allFaults, 0, { maxFaultsPerRun: 1, faultProbability: 0 });
    expect(f).toBeNull();
    expect(next).not.toEqual(s);
  });

  test("is deterministic for a seed", () => {
    const a = decideFault(seedPrng(9), allFaults, 0, { maxFaultsPerRun: 1, faultProbability: 0.5 });
    const b = decideFault(seedPrng(9), allFaults, 0, { maxFaultsPerRun: 1, faultProbability: 0.5 });
    expect(a).toEqual(b);
  });
});

describe("planFaults", () => {
  test("none without eligible points, a share of runs, or a fault budget", () => {
    const s = seedPrng(1);
    expect(planFaults(s, 0, 0, 1, 1)[0]).toEqual([]);
    expect(planFaults(s, 10, 10, 0, 1)[0]).toEqual([]);
    expect(planFaults(s, 10, 10, 1, 0)[0]).toEqual([]);
  });

  test("distinct positions in order, at most the budget, uniform over the points", () => {
    let s = seedPrng("plan");
    const hits = new Array<number>(20).fill(0);
    for (let i = 0; i < 4000; i++) {
      const [plan, next] = planFaults(s, 20, 20, 3, 1);
      s = next;
      expect(plan.length).toBeGreaterThanOrEqual(1);
      expect(plan.length).toBeLessThanOrEqual(3);
      expect([...plan].sort((a, b) => a - b)).toEqual(plan);
      expect(new Set(plan).size).toBe(plan.length);
      for (const p of plan) hits[p] = (hits[p] ?? 0) + 1;
    }
    // The first fault is uniform: each of 20 points takes about 4000 / 20 = 200 of them; later ones follow it.
    for (const h of hits) expect(h).toBeGreaterThan(150);
  });

  test("the first fault lands within the baseline; later ones may reach a longer run's points", () => {
    let s = seedPrng("longer");
    let beyond = 0;
    for (let i = 0; i < 500; i++) {
      const [plan, next] = planFaults(s, 5, 15, 2, 1);
      s = next;
      expect(plan[0]).toBeLessThan(5);
      for (const p of plan) expect(p).toBeLessThan(15);
      if (plan.some((p) => p >= 5)) beyond++;
    }
    expect(beyond).toBeGreaterThan(0);
  });

  test("the same state gives the same plan", () => {
    expect(planFaults(seedPrng(7), 9, 9, 2, 1)).toEqual(planFaults(seedPrng(7), 9, 9, 2, 1));
  });
});
