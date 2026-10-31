/**
 * The three ways a run chooses, held to what the run relies on: a seeded
 * chooser places faults by its plan and draws turns apart from them, a
 * replaying chooser follows the schedule and consumes a recorded turn only
 * at a real choice, and the fault bound stops the questions.
 */
import { nextInt, seedPrng } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import {
  type ChoiceOption,
  type Chooser,
  limitFaults,
  replayChooser,
  seededChooser,
} from "./chooser.ts";

const at = (invocation: string, ordinal: number, ...allowed: string[]): ChoiceOption[] => [
  { label: "none", invocation, ordinal },
  ...allowed.map((label) => ({ label, invocation, ordinal })),
];
const turns = (n: number): ChoiceOption[] =>
  Array.from({ length: n }, (_, i) => ({ label: `i${i}@0`, invocation: `i${i}`, target: "T" }));

describe("seededChooser", () => {
  test("faults land on the planned eligible positions only, kinds drawn from the seed", () => {
    const c = seededChooser(5, { faultPlan: [1, 3], faultProbability: 1, maxFaultsPerRun: 9 });
    const picks = [0, 1, 2, 3, 4].map(() => c.choose("fault", at("i", 0, "error", "crash_after")));
    expect(picks.map((p) => (p > 0 ? 1 : 0))).toEqual([0, 1, 0, 1, 0]);
    // The kinds come from the stream the seed starts: the same seed, the same kinds.
    const again = seededChooser(5, { faultPlan: [1, 3], faultProbability: 1, maxFaultsPerRun: 9 });
    expect(
      [0, 1, 2, 3, 4].map(() => again.choose("fault", at("i", 0, "error", "crash_after"))),
    ).toEqual(picks);
  });

  test("the fault bound holds even when the plan has more positions", () => {
    const c = seededChooser(1, { faultPlan: [0, 1, 2], faultProbability: 1, maxFaultsPerRun: 2 });
    const picks = [0, 1, 2].map(() => c.choose("fault", at("i", 0, "error")));
    expect(picks).toEqual([1, 1, 0]);
  });

  test("without a plan each eligible point takes a fault by probability, the seed deciding", () => {
    const never = seededChooser(1, { faultProbability: 0, maxFaultsPerRun: 9 });
    expect([0, 1, 2].map(() => never.choose("fault", at("i", 0, "error")))).toEqual([0, 0, 0]);
    const always = seededChooser(1, { faultProbability: 1, maxFaultsPerRun: 1 });
    expect([0, 1].map(() => always.choose("fault", at("i", 0, "error")))).toEqual([1, 0]);
  });

  test("turns follow their own stream, untouched by fault decisions, and a lone option is no draw", () => {
    const c = seededChooser(3, { faultPlan: [0], faultProbability: 1, maxFaultsPerRun: 9 });
    expect(c.choose("turn", turns(1))).toBe(0);
    c.choose("fault", at("i", 0, "error"));
    const picked = [c.choose("turn", turns(3)), c.choose("turn", turns(3))];
    let s = seedPrng("turns:3");
    const expected: number[] = [];
    for (let k = 0; k < 2; k++) {
      const [i, next] = nextInt(s, 3);
      s = next;
      expected.push(i);
    }
    expect(picked).toEqual(expected);
    expect(c.seed).toBe(3);
    expect(c.recordsTurns).toBe(false);
  });
});

describe("replayChooser", () => {
  test("takes the recorded fault at its point, none elsewhere, and none the point no longer allows", () => {
    const c = replayChooser({
      seed: 1,
      faults: [
        { invocation: "i", ordinal: 0, fault: "error", target: "T", op: "o" },
        { invocation: "i", ordinal: 1, fault: "ambiguous", target: "T", op: "o" },
      ],
    });
    expect(c.choose("fault", at("i", 0, "crash_before", "error"))).toBe(2);
    expect(c.choose("fault", at("i", 1, "error"))).toBe(0);
    expect(c.choose("fault", at("j", 0, "error"))).toBe(0);
    expect(c.seed).toBe(1);
  });

  test("recorded turns are spent at real choices only, then none is left to spend", () => {
    const c = replayChooser({ seed: 1, faults: [], turns: [2, 1] });
    expect(c.recordsTurns).toBe(true);
    expect(c.choose("turn", turns(1))).toBe(0);
    expect(c.choose("turn", turns(3))).toBe(2);
    expect(c.choose("turn", turns(2))).toBe(1);
    expect(c.choose("turn", turns(2))).toBe(0);
  });

  test("a fault decision with nothing to pick is answered none, by every chooser, without a draw", () => {
    const seeded = seededChooser(1, { faultPlan: [0], faultProbability: 1, maxFaultsPerRun: 9 });
    expect(seeded.choose("fault", at("i", 0))).toBe(0);
    expect(replayChooser({ seed: 1, faults: [] }).choose("fault", at("i", 0))).toBe(0);
  });

  test("without recorded turns the seed's turn stream decides, as it did when the schedule was made", () => {
    const schedule = { seed: 4, faults: [] };
    const replaying = replayChooser(schedule);
    const seeded = seededChooser(4, { faultPlan: [], faultProbability: 0, maxFaultsPerRun: 0 });
    expect(replaying.recordsTurns).toBe(false);
    for (let k = 0; k < 5; k++)
      expect(replaying.choose("turn", turns(3))).toBe(seeded.choose("turn", turns(3)));
  });
});

describe("limitFaults", () => {
  test("stops asking once the bound is reached, and asks about turns regardless", () => {
    const asked: string[] = [];
    const inner: Chooser = {
      seed: 0,
      recordsTurns: true,
      choose: (kind) => {
        asked.push(kind);
        return 1;
      },
    };
    const c = limitFaults(inner, 1);
    expect(c.seed).toBe(0);
    expect(c.recordsTurns).toBe(true);
    expect(c.choose("fault", at("i", 0, "error"))).toBe(1);
    expect(c.choose("fault", at("i", 1, "error"))).toBe(0);
    expect(c.choose("turn", turns(2))).toBe(1);
    expect(asked).toEqual(["fault", "turn"]);
  });
});
