import { extractSpecs, type FunctionSpec, type PredicateOutcome } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import {
  checkedRung,
  checkSpecModule,
  inDomain,
  lemmaBool,
  lemmaUnresolved,
  markerVerdicts,
  render,
} from "./checked.ts";

const source = `
/**
 * @ensures{within-captured} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ refunded <= captured ∧ amount > 0 ==>
 *   (decideRefund(captured, refunded, amount).ok → refunded + amount <= captured)
 * }
 * @ensures{not-a-param} forall (other: int) { other === other }
 * @total
 */
export function decideRefund(captured: number, refunded: number, amount: number) {
  return { ok: amount <= captured };
}
`;
const fn = extractSpecs(source).functions[0] as FunctionSpec;
const property = fn.ensures[0] as NonNullable<FunctionSpec["ensures"][number]>;

/** The predicate the generator would compile for within-captured, against a given decision. */
const withinCaptured =
  (decide: (c: number, r: number, a: number) => { ok: boolean }) =>
  (captured: number, refunded: number, amount: number): PredicateOutcome => {
    if (!lemmaBool(0 <= refunded && refunded <= captured && amount > 0)) return "discarded";
    return !lemmaBool(decide(captured, refunded, amount).ok) ||
      lemmaBool(refunded + amount <= captured)
      ? "held"
      : "refuted";
  };

const buggy = (c: number, _r: number, a: number) => ({ ok: a <= c });
const fixed = (c: number, r: number, a: number) => ({ ok: r + a <= c });
const input = (calls: unknown[][], decide = fixed) => ({
  module: "./domain.ts",
  fn,
  property,
  calls: calls.map((args) => ({ args })),
  predicate: withinCaptured(decide),
});

describe("the CHECKED rung", () => {
  test("held on every distinct input the simulator passed, preconditions discarding", () => {
    const v = checkedRung(
      input([
        [1000, 0, 400],
        [1000, 400, 400],
        [1000, 0, 400],
        [1000, 0, 0],
        [1000, 0, 1.5],
      ]),
    );
    expect(v).toMatchObject({ kind: "CHECKED", inputs: 2, discarded: 2 });
    expect(v.assumptions[0]).toContain("inputs it never passed are not covered");
  });

  test("one input where the claim is false refutes it, with the call it came from", () => {
    const v = checkedRung(
      input(
        [
          [1000, 0, 400],
          [1000, 800, 400],
        ],
        buggy,
      ),
    );
    expect(v).toMatchObject({
      kind: "REFUTED",
      rung: "CHECKED",
      counterexample: {
        binders: [
          { name: "captured", value: "1000" },
          { name: "refunded", value: "800" },
          { name: "amount", value: "400" },
        ],
        call: "decideRefund(1000, 800, 400)",
      },
    });
  });

  test("a throw while evaluating is a counterexample; a non-boolean atom is a malformed property", () => {
    const throwing = checkedRung({
      ...input([[1, 0, 1]]),
      predicate: () => {
        throw new RangeError("boom");
      },
    });
    expect(throwing).toMatchObject({
      kind: "REFUTED",
      counterexample: { error: "RangeError: boom" },
    });
    // The function under test throwing a SyntaxError (JSON.parse, say) is a counterexample too.
    const parsing = checkedRung({
      ...input([[1, 0, 1]]),
      predicate: () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    expect(parsing).toMatchObject({
      kind: "REFUTED",
      counterexample: { error: "SyntaxError: Unexpected token" },
    });
    const malformed = checkedRung({
      ...input([[1, 0, 1]]),
      predicate: () => (lemmaBool(1) ? "held" : "refuted"),
    });
    expect(malformed).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    // A ReferenceError is a name the property's scope missed, not the function failing: never a refutation.
    const missed = checkedRung({
      ...input([[1, 0, 1]]),
      predicate: () => {
        throw new ReferenceError("v is not defined");
      },
    });
    expect(missed).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    const unresolved = checkedRung({
      ...input([[1, 0, 1]]),
      predicate: () => lemmaUnresolved(["missing"]),
    });
    expect(unresolved).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
  });

  test("nothing to check is UNKNOWN, never CHECKED", () => {
    expect(checkedRung(input([]))).toMatchObject({
      kind: "UNKNOWN",
      cause: "gave_up",
      reason: "the simulator never called decideRefund",
    });
    expect(checkedRung(input([[1000, 0, 0]]))).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    expect(checkedRung({ ...input([[1, 0, 1]]), unobservable: "frozen" })).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
    });
    expect(checkedRung({ ...input([[1, 0, 1]]), predicate: undefined })).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
    });
  });

  test("a binder that is not a parameter cannot be checked on the simulator's inputs", () => {
    const v = checkedRung({ ...input([[1, 0, 1]]), property: fn.ensures[1] as typeof property });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
  });

  test("a function named like an Object.prototype member is checked like any other", () => {
    const named = extractSpecs(
      "/** @ensures{p} forall (n: int) { n > 0 } */\nexport function toString(n: number) { return n; }",
    );
    const verdicts = checkSpecModule(
      "./m.ts",
      named,
      { toString: { p: (n: number) => (n > 0 ? "held" : "refuted") } },
      {
        calls: [{ function: "toString", args: [-1] }],
        unobservable: {},
      },
    );
    expect(verdicts).toMatchObject([{ kind: "REFUTED" }]);
  });

  test("markers the rung cannot decide", () => {
    expect(markerVerdicts("./domain.ts", fn)).toMatchObject([
      { property: "@total", kind: "UNKNOWN", cause: "unsupported" },
    ]);
  });
});

describe("domains and guards", () => {
  const b = (text: string) =>
    extractSpecs(`/** @ensures{p} ${text} */\nexport function f(x) {}`).functions[0]?.ensures[0]
      ?.property.binders[0];
  test.each([
    ["forall (x: int) { true }", 3, true],
    ["forall (x: int) { true }", 3.5, false],
    ["forall (x: nat) { true }", -1, false],
    ["forall (x: number ∈ (0, 1]) { true }", 1, true],
    ["forall (x: number ∈ (0, 1]) { true }", 0, false],
    ["forall (x: number ∈ [0, ∞]) { true }", Number.POSITIVE_INFINITY, true],
    ["forall (x: bigint ∈ (0n, 100n]) { true }", 100n, true],
    ["forall (x: bigint ∈ (0n, 100n]) { true }", 0n, false],
    ["forall (x: bigint) { true }", 1, false],
    ["forall (x: string ∈ /a+/) { true }", "aaa", true],
    ["forall (x: string ∈ /a+/) { true }", "aab", false],
    // JavaScript's $ without the m flag is the end of input: a final newline is outside the guard.
    ["forall (x: string ∈ /a/) { true }", "a\n", false],
    ["forall (x: boolean) { true }", false, true],
  ])("%s on %s: %s", (text, value, expected) => {
    const binder = b(text);
    expect(binder).toBeDefined();
    if (binder) expect(inDomain(binder, value)).toBe(expected);
  });

  test("integer guards compare exactly beyond 2^53", () => {
    const binder = b("forall (x: int ∈ [9007199254740993, 9007199254740994]) { true }");
    expect(binder).toBeDefined();
    if (!binder) return;
    expect(inDomain(binder, 9007199254740992)).toBe(false);
    expect(inDomain(binder, 9007199254740994)).toBe(true);
  });

  test("values render as exact literals", () => {
    expect([-0, Number.NaN, 3n, 'a"b', undefined, { n: 1n }].map(render)).toEqual([
      "-0",
      "NaN",
      "3n",
      '"a\\"b"',
      "undefined",
      '{"n":"1n"}',
    ]);
  });
});
