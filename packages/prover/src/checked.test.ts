import { type Binder, type FunctionSpec, forall, type Property, total } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { checkedRung, evaluate, render } from "./checked.ts";
import { checkSpecModule } from "./ladder.ts";

type Decide = (c: number, r: number, a: number) => { ok: boolean };
const buggy: Decide = (c, _r, a) => ({ ok: a <= c });
const fixed: Decide = (c, r, a) => ({ ok: r + a <= c });

const int = (name: string): Binder => ({ name, type: { kind: "number" }, hint: { integer: true } });
const binders = [int("captured"), int("refunded"), int("amount")];
const property: Property = {
  name: "withinCaptured",
  kind: "forall",
  binders,
  imports: [],
  text: "decideRefund(captured, refunded, amount).ok || refunded + amount <= captured",
  line: 3,
};
const fn: FunctionSpec = {
  name: "decideRefund",
  params: binders.map((b) => ({ name: b.name, type: b.type })),
  properties: [
    property,
    {
      name: "decideRefundTotal",
      kind: "total",
      binders,
      imports: [],
      text: "total(decideRefund)",
      line: 9,
    },
  ],
  line: 1,
  offset: 0,
};

/** The spec a spec file would export for within-captured, against a given decision. */
const withinCaptured = (decide: Decide) =>
  forall(decide, {
    when: (captured, refunded, amount) => 0 <= refunded && refunded <= captured && amount > 0,
    ensures: (captured, refunded, amount) =>
      !decide(captured, refunded, amount).ok || refunded + amount <= captured,
  });

const input = (calls: unknown[][], decide = fixed) => ({
  module: "./domain.ts",
  fn,
  property,
  calls: calls.map((args) => ({ args })),
  spec: withinCaptured(decide),
});

describe("the CHECKED rung", () => {
  test("held on every distinct input the simulator passed, the precondition discarding", () => {
    const v = checkedRung(
      input([
        [1000, 0, 400],
        [1000, 400, 400],
        [1000, 0, 400],
        [1000, 0, 0],
        [1000, -1, 5],
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

  test("a claim that throws is false there, and the error is reported", () => {
    const throwing = forall(fixed, {
      ensures: (captured) => {
        if (captured > 10) throw new Error("boom");
        return true;
      },
    });
    const v = checkedRung({
      ...input([
        [5, 0, 1],
        [100, 0, 1],
      ]),
      spec: throwing,
    });
    expect(v).toMatchObject({
      kind: "REFUTED",
      counterexample: { call: "decideRefund(100, 0, 1)", error: "Error: boom" },
    });
  });

  test("a precondition that throws, or a claim that is not a boolean, is a malformed property: UNKNOWN", () => {
    const badWhen = forall(fixed, {
      when: (): boolean => {
        throw new TypeError("cannot read");
      },
      ensures: () => true,
    });
    const v = checkedRung({ ...input([[1, 0, 1]]), spec: badWhen });
    expect(v).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (v.kind === "UNKNOWN")
      expect(v.reason).toContain("the precondition threw TypeError: cannot read");
    const notBoolean = forall(fixed, { ensures: (() => 1) as unknown as () => boolean });
    const w = checkedRung({ ...input([[1, 0, 1]]), spec: notBoolean });
    expect(w).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (w.kind === "UNKNOWN") expect(w.reason).toContain("returned 1, not a boolean");
  });

  test("no call, or no call inside the claim, is UNKNOWN gave_up, never CHECKED", () => {
    const none = checkedRung(input([]));
    expect(none).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (none.kind === "UNKNOWN") expect(none.reason).toContain("never called");
    const outside = checkedRung(input([[1000, 0, 0]]));
    expect(outside).toMatchObject({ kind: "UNKNOWN", cause: "gave_up" });
    if (outside.kind === "UNKNOWN") expect(outside.reason).toContain("1 distinct input(s)");
  });

  test("an unobservable function, a missing spec export and total are UNKNOWN with the cause", () => {
    expect(checkedRung({ ...input([[1, 0, 1]]), unobservable: "frozen" })).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
    });
    expect(checkedRung({ ...input([[1, 0, 1]]), spec: undefined })).toMatchObject({
      kind: "UNKNOWN",
      cause: "unavailable",
    });
    const t = checkedRung({ ...input([[1, 0, 1]]), property: fn.properties[1] as Property });
    expect(t).toMatchObject({
      kind: "UNKNOWN",
      cause: "unsupported",
      property: "decideRefundTotal",
    });
  });
});

describe("evaluate", () => {
  test("the precondition decides inside or outside; the claim decides held or refuted", () => {
    const spec = withinCaptured(fixed);
    expect(evaluate(spec, [10, 0, 5])).toEqual({ outcome: "held" });
    expect(evaluate(spec, [10, 20, 5])).toEqual({ outcome: "discarded" });
    expect(evaluate(withinCaptured(buggy), [10, 8, 5])).toEqual({ outcome: "refuted" });
  });
});

describe("checkSpecModule", () => {
  const specs = { functions: [fn], errors: [] };
  const observed = (calls: unknown[][]) => ({
    calls: calls.map((args) => ({ function: "decideRefund", args })),
    unobservable: {},
  });

  test("every property of every function, the spec taken from the spec file's export of that name", () => {
    const props = { withinCaptured: withinCaptured(fixed), decideRefundTotal: total(fixed) };
    const verdicts = checkSpecModule(
      "./domain.ts",
      specs,
      props,
      { decideRefund: fixed },
      observed([[1000, 0, 400]]),
    );
    expect(verdicts.map((v) => [v.property, v.kind])).toEqual([
      ["withinCaptured", "CHECKED"],
      ["decideRefundTotal", "UNKNOWN"],
    ]);
  });

  test("a spec export that is missing, or names another function, is UNKNOWN unavailable", () => {
    const other: Decide = (c, r, a) => fixed(c, r, a);
    const props = { withinCaptured: withinCaptured(other) };
    const verdicts = checkSpecModule(
      "./domain.ts",
      specs,
      props,
      { decideRefund: fixed },
      observed([[1, 0, 1]]),
    );
    expect(verdicts[0]).toMatchObject({ kind: "UNKNOWN", cause: "unavailable" });
    if (verdicts[0]?.kind === "UNKNOWN")
      expect(verdicts[0].reason).toBe(
        "withinCaptured names a function that is not the module's export decideRefund",
      );
    const missing = checkSpecModule(
      "./domain.ts",
      specs,
      {},
      { decideRefund: fixed },
      observed([]),
    );
    if (missing[0]?.kind === "UNKNOWN")
      expect(missing[0].reason).toContain("exports no spec named withinCaptured");
  });
});

describe("render", () => {
  test("values as literals, exact for the primitive types, JSON for records", () => {
    expect(render(-0)).toBe("-0");
    expect(render(10n)).toBe("10n");
    expect(render('a"b')).toBe('"a\\"b"');
    expect(render({ ok: true, n: 2n })).toBe("{ ok: true, n: 2n }");
    expect(render({ attempts: Number.NaN, "a-b": -0 })).toBe('{ attempts: NaN, "a-b": -0 }');
    expect(render(null)).toBe("null");
    expect(render(undefined)).toBe("undefined");
  });
});

describe("the CHECKED rung and the parameter types", () => {
  test("a call whose argument is not of the declared type is outside the claim, not a counterexample", () => {
    // A shell passing JSON.parse's string where a number is declared: the claim never quantified over it.
    const v = checkedRung(
      input(
        [
          ["12" as unknown as number, 0, 1],
          [1000, 0, 400],
        ],
        buggy,
      ),
    );
    expect(v).toMatchObject({ kind: "CHECKED", inputs: 1, discarded: 1 });
  });
});

describe("render, after review", () => {
  test("never truncates, so two long inputs never collide, and never throws", () => {
    const long = "x".repeat(300);
    expect(render(`${long}a`)).not.toBe(render(`${long}b`));
    expect(render(`${long}a`)).toBe(JSON.stringify(`${long}a`));
    expect(render(new Date(Number.NaN))).toBe("Date(NaN)");
    const throwing = {
      get boom(): number {
        throw new Error("no");
      },
    };
    expect(typeof render(throwing)).toBe("string");
    expect(render([1, "a", { b: 2n }])).toBe('[1, "a", { b: 2n }]');
  });
});
