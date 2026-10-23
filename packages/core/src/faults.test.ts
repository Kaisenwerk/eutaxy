import { describe, expect, test } from "vitest";
import { allFaults, decideFault } from "./faults.ts";
import { seedPrng } from "./prng.ts";

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
