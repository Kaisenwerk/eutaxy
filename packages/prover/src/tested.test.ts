import { extractSpecs, type FunctionSpec, type PredicateOutcome } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { lemmaBool, lemmaUnresolved } from "./checked.ts";
import { checkSpecModule, specLadder } from "./ladder.ts";
import { testedRung } from "./tested.ts";

const source = `
/**
 * @ensures{within-captured} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ refunded <= captured ==>
 *   decideRefund(captured, refunded, amount).refunded <= captured
 * }
 * @ensures{full-refund-allowed} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ amount > 0 ∧ refunded + amount === captured ==>
 *   decideRefund(captured, refunded, amount).ok
 * }
 * @ensures{tight} forall (captured: number) { captured === 0.123456789 ==> captured > 0 }
 */
export function decideRefund(captured: number, refunded: number, amount: number) {}
`;
const fn = extractSpecs(source).functions[0] as FunctionSpec;
const [withinCaptured, fullRefund, tight] = fn.ensures as [
  NonNullable<FunctionSpec["ensures"][number]>,
  NonNullable<FunctionSpec["ensures"][number]>,
  NonNullable<FunctionSpec["ensures"][number]>,
];

type Decide = (c: number, r: number, a: number) => { ok: boolean; refunded: number };
const buggy: Decide = (c, r, a) =>
  a <= 0 || r + a >= c ? { ok: false, refunded: r } : { ok: true, refunded: r + a };
const fixed: Decide = (c, r, a) =>
  a <= 0 || r + a > c ? { ok: false, refunded: r } : { ok: true, refunded: r + a };

/** The predicates the generator would compile, against a given decision. */
const predicates = (decide: Decide) => ({
  "within-captured": (captured: number, refunded: number, amount: number): PredicateOutcome => {
    if (!lemmaBool(0 <= refunded && refunded <= captured)) return "discarded";
    return lemmaBool(decide(captured, refunded, amount).refunded <= captured) ? "held" : "refuted";
  },
  "full-refund-allowed": (captured: number, refunded: number, amount: number): PredicateOutcome => {
    if (!lemmaBool(0 <= refunded && amount > 0 && refunded + amount === captured))
      return "discarded";
    return lemmaBool(decide(captured, refunded, amount).ok) ? "held" : "refuted";
  },
});

const input = (property: typeof withinCaptured, decide = fixed, seed = "corpus") => ({
  module: "./domain.ts",
  fn,
  property,
  predicate: predicates(decide)[property.name as "within-captured" | "full-refund-allowed"],
  seed,
});

describe("the TESTED rung", () => {
  test("held on generated inputs is TESTED, with the seed and how many fell outside the claim", () => {
    const v = testedRung(input(withinCaptured));
    expect(v).toMatchObject({ kind: "TESTED", inputs: 100, seed: "corpus" });
    if (v.kind !== "TESTED") return;
    expect(v.discarded).toBeGreaterThan(0);
    expect(v.assumptions[0]).toContain("seed corpus");
    expect(v.assumptions[1]).toContain("assumed pure");
    expect(testedRung(input(withinCaptured))).toEqual(v);
  });

  test("a generated input where the claim is false is REFUTED and shrunk", () => {
    const v = testedRung(input(fullRefund, buggy));
    expect(v).toMatchObject({ kind: "REFUTED", rung: "TESTED" });
    if (v.kind !== "REFUTED") return;
    const values = v.counterexample.binders.map((b) => Number(b.value));
    expect(v.counterexample.call).toBeUndefined();
    // Inside the claim, false, and no binder can move alone without leaving the claim.
    const [captured, refunded, amount] = values as [number, number, number];
    expect(refunded).toBeGreaterThanOrEqual(0);
    expect(amount).toBeGreaterThan(0);
    expect(refunded + amount).toBe(captured);
    expect(Math.abs(captured)).toBeLessThanOrEqual(16);
    expect(v.assumptions[0]).toContain("then shrunk");
    expect(testedRung(input(fullRefund, buggy))).toEqual(v);
  });

  test("a throw from the function is a counterexample, kept through shrinking", () => {
    const v = testedRung({
      ...input(withinCaptured),
      predicate: (captured: number) => {
        if (captured > 5) throw new RangeError(`too much: ${captured}`);
        return "held";
      },
    });
    expect(v).toMatchObject({
      kind: "REFUTED",
      rung: "TESTED",
      counterexample: {
        error: "RangeError: too much: 6",
        binders: [
          { name: "captured", value: "6" },
          { name: "refunded", value: "0" },
          { name: "amount", value: "0" },
        ],
      },
    });
  });

  test("a malformed property is UNKNOWN, never REFUTED", () => {
    expect(
      testedRung({ ...input(withinCaptured), predicate: () => lemmaBool(1) as never }),
    ).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    expect(
      testedRung({ ...input(withinCaptured), predicate: () => lemmaUnresolved(["missing"]) }),
    ).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    expect(testedRung({ ...input(withinCaptured), predicate: undefined })).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
    });
  });

  test("preconditions that sampling cannot meet give up, with the count", () => {
    const v = testedRung({
      ...input(tight),
      predicate: (captured: number): PredicateOutcome =>
        captured === 0.123456789 ? "held" : "discarded",
    });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (v.kind === "UNKNOWN")
      expect(v.reason).toMatch(/^all \d+ distinct generated inputs were outside the claim/);
  });

  test.each([
    "forall (s: string ∈ /^(?!)$/) { s === s }",
    "forall (s: int ∈ (0, 1)) { s === s }",
    "forall (s: string ∈ /^a{0,4294967296}b$/) { s === s }",
  ])("a guard no draw can meet gives up rather than looping or throwing: %s", (text) => {
    const spec = extractSpecs(`/** @ensures{p} ${text} */\nexport function f(s: string) {}`)
      .functions[0] as FunctionSpec;
    const v = testedRung({
      module: "./m.ts",
      fn: spec,
      property: spec.ensures[0] as NonNullable<FunctionSpec["ensures"][number]>,
      predicate: () => "held",
      seed: "s",
    });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
  });

  test("fewer inputs when asked; a count that is not a positive integer is the caller's error", () => {
    expect(testedRung({ ...input(withinCaptured), inputs: 7 })).toMatchObject({
      kind: "TESTED",
      inputs: 7,
    });
    expect(() => testedRung({ ...input(withinCaptured), inputs: 0 })).toThrow(RangeError);
    expect(() => testedRung({ ...input(withinCaptured), inputs: 2.5 })).toThrow(RangeError);
  });

  test("inputs are counted distinct, as the CHECKED rung counts them", () => {
    const spec = extractSpecs(
      "/** @ensures{p} forall (b: boolean) { f(b) === f(b) } */\nexport function f(b: boolean) {}",
    ).functions[0] as FunctionSpec;
    const v = testedRung({
      module: "./m.ts",
      fn: spec,
      property: spec.ensures[0] as NonNullable<FunctionSpec["ensures"][number]>,
      predicate: () => "held",
      seed: "s",
    });
    expect(v).toMatchObject({ kind: "TESTED", inputs: 2, discarded: 0 });
  });
});

describe("the ladder", () => {
  const calls = (...args: number[][]) => args.map((a) => ({ args: a }));
  const ladder = (property: typeof withinCaptured, decide: Decide, observed: number[][]) =>
    specLadder(
      {
        module: "./domain.ts",
        fn,
        property,
        calls: calls(...observed),
        predicate: input(property, decide).predicate,
      },
      { tested: { seed: "corpus" } },
    );

  test("CHECKED and TESTED both hold: TESTED, carrying the simulator's inputs", () => {
    const v = ladder(withinCaptured, fixed, [
      [1000, 0, 400],
      [1000, 400, 400],
    ]);
    expect(v).toMatchObject({ kind: "TESTED", inputs: 100, checked: 2 });
    expect(v.assumptions.some((a) => a.includes("the simulator passed"))).toBe(true);
  });

  test("a counterexample the simulator passed wins over sampling, with its call", () => {
    const v = ladder(fullRefund, buggy, [[1000, 600, 400]]);
    expect(v).toMatchObject({
      kind: "REFUTED",
      rung: "CHECKED",
      counterexample: { call: "decideRefund(1000, 600, 400)" },
    });
  });

  test("a counterexample sampling finds when the simulator passed nothing refuting", () => {
    expect(ladder(fullRefund, buggy, [[1000, 0, 400]])).toMatchObject({
      kind: "REFUTED",
      rung: "TESTED",
    });
    expect(ladder(fullRefund, buggy, [])).toMatchObject({ kind: "REFUTED", rung: "TESTED" });
  });

  test("the simulator passed nothing, sampling held: TESTED without a checked count, saying why", () => {
    const v = ladder(withinCaptured, fixed, []);
    expect(v).toMatchObject({ kind: "TESTED" });
    expect("checked" in v).toBe(false);
    expect(v.assumptions.at(-1)).toBe("the simulator never called decideRefund");
  });

  test("a property malformed on an input the simulator passed stays UNKNOWN, whatever sampling finds", () => {
    const v = specLadder(
      {
        module: "./domain.ts",
        fn,
        property: withinCaptured,
        calls: calls([123456789, 0, 0]),
        predicate: (captured: number) => (captured === 123456789 ? lemmaBool(1) : "held") as never,
      },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (v.kind === "UNKNOWN") expect(v.reason).toContain("could not be evaluated");
  });

  test("a property malformed on a generated input stays UNKNOWN, whatever the simulator passed", () => {
    const v = specLadder(
      {
        module: "./domain.ts",
        fn,
        property: withinCaptured,
        calls: calls([1000, 0, 400]),
        // Sound on the simulator's input, a non-boolean atom on others.
        predicate: (captured: number) => (captured === 1000 ? "held" : lemmaBool(1)) as never,
      },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (v.kind === "UNKNOWN") expect(v.reason).toContain("could not be evaluated");
  });

  test("both rungs unavailable for the same reason say it once", () => {
    const v = specLadder(
      { module: "./domain.ts", fn, property: withinCaptured, calls: [], predicate: undefined },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
      reason: "the property's predicate was not compiled",
    });
  });

  test("CHECKED stands when sampling gives up, and says so", () => {
    const v = specLadder(
      {
        module: "./domain.ts",
        fn,
        property: tight,
        calls: calls([0.123456789, 0, 0]),
        predicate: (captured: number): PredicateOutcome =>
          captured === 0.123456789 ? "held" : "discarded",
      },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "CHECKED", inputs: 1 });
    expect(v.assumptions.at(-1)).toMatch(/^not TESTED: all \d+ distinct generated inputs/);
  });

  test("neither rung decided: one UNKNOWN naming both reasons", () => {
    const v = specLadder(
      {
        module: "./domain.ts",
        fn,
        property: tight,
        calls: [],
        predicate: (captured: number): PredicateOutcome =>
          captured === 0.123456789 ? "held" : "discarded",
      },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (v.kind === "UNKNOWN")
      expect(v.reason).toMatch(
        /^the simulator never called decideRefund; generated inputs: all \d+ distinct generated inputs were outside the claim: its preconditions admit too few of the binders' domains to sample$/,
      );
  });

  test("without tested options the ladder stops at CHECKED", () => {
    expect(
      specLadder({
        module: "./domain.ts",
        fn,
        property: withinCaptured,
        calls: calls([1000, 0, 400]),
        predicate: input(withinCaptured).predicate,
      }),
    ).toMatchObject({ kind: "CHECKED" });
  });

  test("checkSpecModule runs every property through the ladder", () => {
    const verdicts = checkSpecModule(
      "./domain.ts",
      extractSpecs(source),
      { decideRefund: predicates(buggy) },
      { calls: [{ function: "decideRefund", args: [1000, 0, 400] }], unobservable: {} },
      { tested: { seed: "corpus" } },
    );
    expect(verdicts.map((v) => [v.property, v.kind])).toEqual([
      ["within-captured", "TESTED"],
      ["full-refund-allowed", "REFUTED"],
      ["tight", "UNKNOWN"],
    ]);
  });
});
