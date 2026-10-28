import { type Binder, type FunctionSpec, forall, type Property, type SpecType } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { checkSpecModule, specLadder } from "./ladder.ts";
import { testedRung } from "./tested.ts";

type Decide = (c: number, r: number, a: number) => { ok: boolean; refunded: number };
const buggy: Decide = (c, r, a) =>
  a <= 0 || r + a >= c ? { ok: false, refunded: r } : { ok: true, refunded: r + a };
const fixed: Decide = (c, r, a) =>
  a <= 0 || r + a > c ? { ok: false, refunded: r } : { ok: true, refunded: r + a };

const int = (name: string, hint: Binder["hint"] = { integer: true }): Binder => ({
  name,
  type: { kind: "number" },
  hint,
});
const binders = [int("captured"), int("refunded"), int("amount")];
const prop = (name: string, b = binders): Property => ({
  name,
  kind: "forall",
  binders: b,
  imports: [],
  text: name,
  line: 1,
});
const withinCaptured = prop("withinCaptured");
const fullRefund = prop("fullRefundAllowed");
const tight = prop("tight", [{ name: "captured", type: { kind: "number" } }]);
const fn: FunctionSpec = {
  name: "decideRefund",
  params: binders.map((b) => ({ name: b.name, type: b.type })),
  properties: [withinCaptured, fullRefund, tight],
  line: 1,
  offset: 0,
};

/** The specs a spec file would export, against a given decision. */
const specs = (decide: Decide) => ({
  withinCaptured: forall(decide, {
    when: (captured, refunded, amount) =>
      Number.isInteger(captured) &&
      Number.isInteger(refunded) &&
      Number.isInteger(amount) &&
      0 <= refunded &&
      refunded <= captured,
    ensures: (captured, refunded, amount) =>
      decide(captured, refunded, amount).refunded <= captured,
  }),
  fullRefundAllowed: forall(decide, {
    when: (captured, refunded, amount) =>
      Number.isInteger(captured) &&
      Number.isInteger(refunded) &&
      Number.isInteger(amount) &&
      0 <= refunded &&
      amount > 0 &&
      refunded + amount === captured,
    ensures: (captured, refunded, amount) => decide(captured, refunded, amount).ok,
  }),
  tight: forall(decide, {
    when: (captured) => captured === 0.123456789,
    ensures: (captured) => captured > 0,
  }),
});

const input = (property: Property, decide = fixed, seed = "corpus") => ({
  module: "./domain.ts",
  fn,
  property,
  spec: specs(decide)[property.name as "withinCaptured" | "fullRefundAllowed" | "tight"],
  seed,
});

describe("the TESTED rung", () => {
  test("held on generated inputs is TESTED, with the seed and how many fell outside the claim", () => {
    const v = testedRung(input(withinCaptured));
    expect(v).toMatchObject({ kind: "TESTED", inputs: 100, seed: "corpus" });
    if (v.kind !== "TESTED") return;
    expect(v.discarded).toBeGreaterThan(0);
    expect(v.assumptions.some((a) => a.includes("seed corpus"))).toBe(true);
    expect(v.assumptions.some((a) => a.includes("assumed pure"))).toBe(true);
  });

  test("the same seed gives the same verdict on every run; another seed, another sample", () => {
    expect(testedRung(input(withinCaptured))).toEqual(testedRung(input(withinCaptured)));
    const a = testedRung(input(fullRefund, buggy, "a"));
    const b = testedRung(input(fullRefund, buggy, "b"));
    expect(a.kind).toBe("REFUTED");
    expect(b.kind).toBe("REFUTED");
  });

  test("a counterexample is shrunk toward zero and reported without a call", () => {
    const v = testedRung(input(fullRefund, buggy));
    expect(v).toMatchObject({ kind: "REFUTED", rung: "TESTED" });
    if (v.kind !== "REFUTED") return;
    expect(v.counterexample.call).toBeUndefined();
    const values = Object.fromEntries(
      v.counterexample.binders.map((b) => [b.name, Number(b.value)]),
    );
    // The shrinker moves one binder at a time, and the precondition ties the three together, so the
    // counterexample stays on the equation; what it must be is a small, positive full refund.
    const { captured = Number.NaN, refunded = Number.NaN, amount = Number.NaN } = values;
    expect(refunded + amount).toBe(captured);
    expect(amount).toBeGreaterThan(0);
    expect(captured).toBeLessThanOrEqual(16);
    expect(v.assumptions[0]).toContain("then shrunk");
  });

  test("a precondition sampling cannot meet is UNKNOWN gave_up, never TESTED", () => {
    const v = testedRung(input(tight));
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (v.kind === "UNKNOWN") expect(v.reason).toContain("outside the claim");
  });

  test("the number of inputs is configurable and must be positive", () => {
    expect(testedRung({ ...input(withinCaptured), inputs: 150 })).toMatchObject({
      kind: "TESTED",
      inputs: 150,
    });
    // Every edge inside the claim is tried whatever the budget, so a small one is exceeded.
    const small = testedRung({ ...input(withinCaptured), inputs: 5 });
    expect(small).toMatchObject({ kind: "TESTED" });
    if (small.kind === "TESTED") expect(small.inputs).toBeGreaterThan(5);
    expect(() => testedRung({ ...input(withinCaptured), inputs: 0 })).toThrow(RangeError);
  });

  test("a binder of a type the rung cannot draw is UNKNOWN unsupported", () => {
    const unknownType: SpecType = { kind: "unknown", text: "Date" };
    const v = testedRung({
      ...input(withinCaptured),
      property: prop("p", [{ name: "when", type: unknownType }]),
    });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (v.kind === "UNKNOWN") expect(v.reason).toContain("cannot draw from: Date");
  });

  test("records, nullable types, unions of literals and tagged unions are drawn and shrunk", () => {
    type Challenge = { readonly attempts: number; readonly locked: boolean };
    const admit = (c: Challenge | null, matches: boolean): { ok: boolean } => ({
      ok: c !== null && !c.locked && matches && c.attempts < 5,
    });
    const challenge: SpecType = {
      kind: "record",
      name: "Challenge",
      fields: [
        { name: "attempts", type: { kind: "number" } },
        { name: "locked", type: { kind: "boolean" } },
      ],
    };
    const property = prop("admits", [
      { name: "c", type: { kind: "union", members: [challenge, { kind: "null" }] } },
      { name: "matches", type: { kind: "boolean" } },
    ]);
    const sound = forall(admit, {
      when: (c) => c !== null && !c.locked && c.attempts < 5,
      ensures: (c, matches) => admit(c, matches).ok === matches,
    });
    const held = testedRung({ module: "m", fn, property, spec: sound, seed: "s" });
    expect(held).toMatchObject({ kind: "TESTED", inputs: 100 });
    // A claim false for a locked challenge: the counterexample shrinks to the simplest record that still breaks it.
    const wrong = forall(admit, {
      when: (c) => c !== null,
      ensures: (c, matches) => admit(c, matches).ok === matches,
    });
    const refuted = testedRung({ module: "m", fn, property, spec: wrong, seed: "s" });
    expect(refuted).toMatchObject({ kind: "REFUTED", rung: "TESTED" });
    if (refuted.kind !== "REFUTED") return;
    expect(refuted.counterexample.binders.map((b) => b.value)).toEqual([
      "{ attempts: 0, locked: true }",
      "true",
    ]);
    const status = prop("status", [
      {
        name: "s",
        type: {
          kind: "union",
          members: [
            { kind: "literal", value: "invited" },
            { kind: "literal", value: "active" },
            { kind: "null" },
          ],
        },
      },
    ]);
    const seen = new Set<unknown>();
    const look = forall((s: "invited" | "active" | null) => s, {
      ensures: (s) => {
        seen.add(s);
        return true;
      },
    });
    expect(testedRung({ module: "m", fn, property: status, spec: look, seed: "s" })).toMatchObject({
      kind: "TESTED",
      inputs: 3,
    });
    expect(seen).toEqual(new Set(["invited", "active", null]));
  });
});

describe("edge values first", () => {
  test("binder j starts j places into its edges: false and -0 meet, two numbers differ", () => {
    const flag: Binder = { name: "flag", type: { kind: "boolean" } };
    const x: Binder = { name: "x", type: { kind: "number" } };
    const g = (flag: boolean, x: number) => flag || 1 / x !== Number.NEGATIVE_INFINITY;
    const claim = forall(g, { ensures: (flag, x) => g(flag, x) });
    const two: FunctionSpec = {
      name: "g",
      params: [
        { name: "flag", type: flag.type },
        { name: "x", type: x.type },
      ],
      properties: [],
      line: 1,
      offset: 0,
    };
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const property: Property = { ...prop("claim", [flag, x]), name: "claim" };
      expect(testedRung({ module: "m", fn: two, property, spec: claim, seed }), seed).toMatchObject(
        {
          kind: "REFUTED",
        },
      );
    }
  });

  test("however many edges there are, half the input budget still goes to random draws", () => {
    const members: SpecType[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "literal",
      value: `m${i}`,
    }));
    const s: Binder = { name: "s", type: { kind: "union", members } };
    const n: Binder = { name: "n", type: { kind: "number" }, hint: { integer: true } };
    const h = (_s: string, n: number) => n;
    // False only at n = 2, which is no edge: the random draws must reach it.
    const notTwo = forall(h, { ensures: (s, n) => h(s, n) !== 2 });
    const two: FunctionSpec = {
      name: "h",
      params: [
        { name: "s", type: s.type },
        { name: "n", type: n.type },
      ],
      properties: [],
      line: 1,
      offset: 0,
    };
    const property: Property = { ...prop("notTwo", [s, n]), name: "notTwo" };
    const always = forall(h, { ensures: (s, n) => h(s, n) === n });
    const held = testedRung({ module: "m", fn: two, property, spec: always, seed: "a" });
    // 400 edge assignments (the union in step and rotated), then 50 random ones.
    expect(held).toMatchObject({ kind: "TESTED" });
    if (held.kind === "TESTED") expect(held.inputs).toBeGreaterThanOrEqual(400 + 50);
    const verdicts = ["a", "b", "c", "d", "e", "f", "g", "h"].map(
      (seed) => testedRung({ module: "m", fn: two, property, spec: notTwo, seed }).kind,
    );
    expect(verdicts).toContain("REFUTED");
  });

  test("every edge is tried even when there are more of them than the input budget", () => {
    const members: SpecType[] = Array.from({ length: 101 }, (_, i) => ({
      kind: "literal",
      value: i,
    }));
    const b: Binder = { name: "x", type: { kind: "union", members } };
    const pick = (x: number) => x;
    const notLast = forall(pick, { ensures: (x) => pick(x) !== 100 });
    const one: FunctionSpec = {
      name: "pick",
      params: [{ name: "x", type: b.type }],
      properties: [],
      line: 1,
      offset: 0,
    };
    for (const seed of ["a", "b", "c", "d"]) {
      const property: Property = { ...prop("notLast", [b]), name: "notLast" };
      const v = testedRung({ module: "m", fn: one, property, spec: notLast, seed });
      expect(v, seed).toMatchObject({ kind: "REFUTED" });
    }
  });

  const n: Binder = { name: "x", type: { kind: "number" } };
  const onlyX = (name: string): Property => ({ ...prop(name, [n]), name });
  const one: FunctionSpec = {
    name: "same",
    params: [{ name: "x", type: { kind: "number" } }],
    properties: [],
    line: 1,
    offset: 0,
  };
  const same = (x: number) => x;

  test("a claim false only on NaN, or only on -0, is refuted under every seed", () => {
    const reflexive = forall(same, { ensures: (x) => same(x) === x });
    const signOfZero = forall(same, { ensures: (x) => 1 / same(x) !== Number.NEGATIVE_INFINITY });
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      for (const [property, spec, witness] of [
        [onlyX("reflexive"), reflexive, "NaN"],
        [onlyX("signOfZero"), signOfZero, "-0"],
      ] as const) {
        const v = testedRung({ module: "m", fn: one, property, spec, seed });
        expect(v, `${property.name} with seed ${seed}`).toMatchObject({ kind: "REFUTED" });
        if (v.kind === "REFUTED") expect(v.counterexample.binders[0]?.value).toBe(witness);
      }
    }
  });
});

describe("the ladder", () => {
  const calls = (args: unknown[][]) => args.map((a) => ({ args: a }));

  test("CHECKED then TESTED: both hold is TESTED with the simulator's count beside it", () => {
    const v = specLadder(
      { ...input(withinCaptured), calls: calls([[1000, 0, 400]]) },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "TESTED", inputs: 100, checked: 1 });
  });

  test("the simulator's counterexample comes first; a generated one when the simulator missed it", () => {
    const atChecked = specLadder(
      { ...input(fullRefund, buggy), calls: calls([[1000, 600, 400]]) },
      { tested: { seed: "corpus" } },
    );
    expect(atChecked).toMatchObject({ kind: "REFUTED", rung: "CHECKED" });
    const atTested = specLadder(
      { ...input(fullRefund, buggy), calls: calls([[1000, 0, 400]]) },
      { tested: { seed: "corpus" } },
    );
    expect(atTested).toMatchObject({ kind: "REFUTED", rung: "TESTED" });
  });

  test("without the TESTED rung, or when sampling gives up, CHECKED stands and says why", () => {
    const only = specLadder({ ...input(withinCaptured), calls: calls([[1000, 0, 400]]) });
    expect(only).toMatchObject({ kind: "CHECKED", inputs: 1 });
    const gaveUp = specLadder(
      { ...input(tight), calls: calls([[0.123456789, 0, 0]]) },
      { tested: { seed: "corpus" } },
    );
    expect(gaveUp).toMatchObject({ kind: "CHECKED", inputs: 1 });
    expect(gaveUp.assumptions.at(-1)).toContain("not TESTED: all");
  });

  test("without a scenario the ladder starts at TESTED and never says the simulator missed a call", () => {
    const v = specLadder(
      { ...input(withinCaptured), calls: [] },
      { checked: false, tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "TESTED", inputs: 100 });
    expect(v).not.toHaveProperty("checked");
    expect(JSON.stringify(v)).not.toContain("never called");
    const total: Property = { ...withinCaptured, name: "t", kind: "total" };
    const t = specLadder({ ...input(total), calls: [] }, { checked: false, tested: { seed: "c" } });
    expect(t).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (t.kind === "UNKNOWN") expect(t.reason).toContain("generated inputs");
    expect(() => specLadder({ ...input(withinCaptured), calls: [] }, { checked: false })).toThrow(
      RangeError,
    );
  });

  test("neither rung deciding names both reasons", () => {
    const v = specLadder({ ...input(tight), calls: calls([]) }, { tested: { seed: "corpus" } });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (v.kind === "UNKNOWN") {
      expect(v.reason).toContain("never called");
      expect(v.reason).toContain("generated inputs:");
    }
  });

  test("a malformed property at either rung is UNKNOWN unsupported, whatever the other rung found", () => {
    const malformed = forall(fixed, {
      when: (captured) => captured > 500,
      ensures: (() => "yes") as unknown as () => boolean,
    });
    const v = specLadder(
      { ...input(withinCaptured), spec: malformed, calls: calls([[1, 0, 1]]) },
      { tested: { seed: "corpus" } },
    );
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
  });

  test("checkSpecModule runs every property with the module's calls", () => {
    const verdicts = checkSpecModule(
      "./domain.ts",
      { functions: [fn], errors: [] },
      specs(fixed),
      { decideRefund: fixed },
      { calls: [{ function: "decideRefund", args: [1000, 0, 400] }], unobservable: {} },
      { tested: { seed: "corpus" } },
    );
    expect(verdicts.map((v) => [v.property, v.kind])).toEqual([
      ["withinCaptured", "TESTED"],
      ["fullRefundAllowed", "TESTED"],
      ["tight", "UNKNOWN"],
    ]);
  });
});
