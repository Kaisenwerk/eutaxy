import { readSpecs } from "@eutaxy/prover/reader";
import { describe, expect, test } from "vitest";
import { findLean } from "./lean.ts";
import { engineAssumptions, prepare, proveModule } from "./prove.ts";

const refund = `
export interface RefundDecision { readonly ok: boolean; readonly refunded: number }
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
`;
const refundSpecs = `
import { forall, total } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";
export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).refunded <= captured,
});
export const fullRefundAllowed = forall(decideRefund, {
  when: (captured, refunded, amount) => 0 <= refunded && amount > 0 && refunded + amount === captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).ok,
});
export const decideRefundTotal = total(decideRefund);
`;
const read = (module: string, spec: string) =>
  readSpecs({ module, spec, moduleSpecifiers: ["./domain.ts"] });
const specOn = (fn: string, body: string, name = "p") =>
  `import { forall } from "eutaxy/spec";\nimport { ${fn} } from "./domain.ts";\nexport const ${name} = forall(${fn}, { ensures: ${body} });`;

describe("prepare", () => {
  test("a function outside the subset names the construct and the line; the others are still emitted", () => {
    const source =
      "export function f(x: number): number {\n  return x / 1;\n}\nexport function g(x: number): number { return x; }";
    const spec =
      `${specOn("f", "(x) => f(x) === x")}\n${specOn("g", "(x) => g(x) === x", "q")}`.replace(
        'import { forall } from "eutaxy/spec";\nimport { g }',
        "import { g }",
      );
    const p = prepare({ source, specs: read(source, spec) });
    expect(p.outside.get("f")).toBe("outside the engine's subset (line 2): the / operator");
    expect(p.emitted.theorems.map((t) => t.function)).toEqual(["g"]);
  });

  test("a spec that does not read is reported, not silently dropped", () => {
    const source = "export function f(x: number): number { return x; }";
    const specs = read(
      source,
      'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const p = forall(f, { when: () => true });',
    );
    const p = prepare({ source, specs });
    expect(p.specErrors).toEqual([
      { line: 3, message: expect.stringContaining("needs an ensures") },
    ]);
    expect(p.emitted.theorems).toEqual([]);
  });

  test("a function the reader cannot find at the top level is unsupported, not thrown", async () => {
    const source =
      "export namespace N {\n  export function f(x: number): number { return x; }\n}\nexport const f = N.f;";
    const specs = {
      functions: [
        {
          name: "f",
          params: [{ name: "x", type: { kind: "number" as const } }],
          properties: [
            {
              name: "p",
              kind: "forall" as const,
              binders: [{ name: "x", type: { kind: "number" as const } }],
              ensures: { params: ["x"], body: "f(x) === x", block: false, line: 1 },
              imports: [{ local: "f", fn: "f" }],
              text: "f(x) === x",
              line: 1,
            },
          ],
          line: 1,
          offset: 0,
        },
      ],
      errors: [],
    };
    const r = await proveModule({ source, specs });
    expect(r.results).toEqual([
      {
        function: "f",
        property: "p",
        outcome: {
          kind: "UNKNOWN",
          cause: "unsupported",
          reason: "outside the engine's subset: the module declares no function f at its top level",
        },
      },
    ]);
  });

  test("a spec on a nested function does not attach to a top-level function of the same name", () => {
    // The reader records the declaration's offset; the subset reader finds the top-level one at another offset.
    const source =
      "export namespace N {\n  export function f(x: number): number { return x + 1; }\n}\nexport function f(x: number): number { return x; }";
    const specs = read(source, specOn("f", "(x) => f(x) === x"));
    const nested = {
      ...specs,
      functions: specs.functions.map((fn) => ({ ...fn, offset: source.indexOf("(x") })),
    };
    const p = prepare({ source, specs: nested });
    expect(p.outside.get("f")).toContain("is not the module's top-level declaration");
    expect(p.emitted.theorems).toEqual([]);
  });

  test("only the functions asked for get theorems; callees are emitted all the same", () => {
    const source = `${refund}\nexport function twice(n: number): number { return n + n; }`;
    const p = prepare({
      source,
      specs: read(
        source,
        `${refundSpecs}\nexport const twiceIs = forall(twice, { ensures: (n) => twice(n) === n + n });`,
      ),
      functions: ["decideRefund"],
    });
    expect(p.emitted.theorems.map((t) => t.property)).toEqual([
      "withinCaptured",
      "fullRefundAllowed",
    ]);
    expect(p.emitted.source).toContain("def f_twice");
  });
});

const toolchain = await findLean();
const required = process.env["EUTAXY_REQUIRE_LEAN"] === "1";

describe.skipIf("unavailable" in toolchain && !required)("proofs over lists", () => {
  test("name the list model, wherever the list sits: in a record field too", async () => {
    const source =
      "export interface R { readonly xs: number[] }\nexport function n(r: R): number { return r.xs.length; }";
    const spec =
      'import { forall } from "eutaxy/spec";\nimport { n } from "./domain.ts";\nexport const p = forall(n, { ensures: (r) => n(r) >= 0 });';
    const proofs = await proveModule({ source, specs: read(source, spec) });
    const outcome = proofs.results[0]?.outcome;
    expect(outcome?.kind).toBe("PROVEN");
    if (outcome?.kind === "PROVEN") expect(outcome.assumptions.join("\n")).toContain("dense");
  }, 120_000);

  test("a recursive function's proof names its stack; an unrelated proof names neither model", async () => {
    const source =
      "export function sum(xs: readonly number[]): number {\n  if (xs.length === 0) return 0;\n  return (xs[0] ?? 0) + sum(xs.slice(1));\n}\nexport function same(n: number): number { return n; }";
    const spec =
      'import { forall } from "eutaxy/spec";\nimport { same, sum } from "./domain.ts";\nexport const empty = forall(sum, { when: (xs) => xs.length === 0, ensures: (xs) => sum(xs) === 0 });\nexport const id = forall(same, { ensures: (n) => same(n) === n });';
    const proofs = await proveModule({ source, specs: read(source, spec) });
    const byProperty = new Map(proofs.results.map((r) => [r.property, r.outcome]));
    const empty = byProperty.get("empty");
    const id = byProperty.get("id");
    expect(empty?.kind).toBe("PROVEN");
    expect(id?.kind).toBe("PROVEN");
    if (empty?.kind === "PROVEN") {
      expect(empty.assumptions.join("\n")).toContain("dense");
      expect(empty.assumptions.join("\n")).toContain("call stack is bounded");
    }
    if (id?.kind === "PROVEN") {
      expect(id.assumptions.join("\n")).not.toContain("dense");
      expect(id.assumptions.join("\n")).not.toContain("call stack");
    }
  }, 120_000);

  test("the models are named where the claim's arrows meet them, and on totality too", async () => {
    const source =
      "export function sum(xs: readonly number[]): number {\n  if (xs.length === 0) return 0;\n  return (xs[0] ?? 0) + sum(xs.slice(1));\n}\nexport function same(xs: readonly number[]): readonly number[] { return xs; }";
    const spec =
      'import { forall, total } from "eutaxy/spec";\nimport { same, sum } from "./domain.ts";\nexport const viaArrow = forall(same, { ensures: (xs) => sum(same(xs)) === sum(xs) });\nexport const viaParens = forall(same, { ensures: (xs) => (sum)(xs) === (sum)(same(xs)) });\nexport const ends = total(sum);';
    const proofs = await proveModule({ source, specs: read(source, spec) });
    for (const r of proofs.results) {
      expect(r.outcome.kind, r.property).toBe("PROVEN");
      if (r.outcome.kind === "PROVEN")
        expect(r.outcome.assumptions.join("\n"), r.property).toContain("call stack is bounded");
    }
  }, 120_000);
});

describe.skipIf("unavailable" in toolchain && !required)("proveModule with the pinned Lean", () => {
  test("proves what holds, gives up on what does not, proves total by acceptance", async () => {
    const r = await proveModule({ source: refund, specs: read(refund, refundSpecs) });
    expect(
      r.results.map((x) => [
        x.property,
        x.outcome.kind === "UNKNOWN" ? x.outcome.cause : x.outcome.kind,
      ]),
    ).toEqual([
      ["withinCaptured", "PROVEN"],
      ["fullRefundAllowed", "gave_up"],
      ["decideRefundTotal", "PROVEN"],
    ]);
    const proven = r.results[0]?.outcome;
    expect(proven).toMatchObject({
      engine: { name: "lean", version: "4.35.0" },
      assumptions: engineAssumptions,
    });
    expect(engineAssumptions.some((a) => a.includes("lone surrogate"))).toBe(true);
    const gaveUp = r.results[1]?.outcome;
    if (gaveUp?.kind === "UNKNOWN")
      expect(gaveUp.reason).toContain("omega could not prove the goal");
    expect(r.lean).toMatch(/theorem t\d+_decideRefund_withinCaptured/);
  }, 120_000);

  test("a timeout is gave_up, never a verdict", async () => {
    const r = await proveModule({ source: refund, specs: read(refund, refundSpecs), timeoutMs: 1 });
    expect(
      r.results.every((x) => x.outcome.kind === "UNKNOWN" && x.outcome.cause === "gave_up"),
    ).toBe(true);
  }, 30_000);
});
