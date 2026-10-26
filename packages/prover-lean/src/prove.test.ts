import { describe, expect, test } from "vitest";
import { findLean } from "./lean.ts";
import { engineAssumptions, prepare, proveModule } from "./prove.ts";

const refund = `
export interface RefundDecision { readonly ok: boolean; readonly refunded: number }
/**
 * @ensures{within-captured} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ refunded <= captured ==> decideRefund(captured, refunded, amount).refunded <= captured
 * }
 * @ensures{full-refund-allowed} forall (captured refunded amount: int) {
 *   0 <= refunded ∧ amount > 0 ∧ refunded + amount === captured ==> decideRefund(captured, refunded, amount).ok
 * }
 * @total
 * @throws
 */
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
`;

describe("prepare", () => {
  test("a function outside the subset names the construct and the line; the others are still emitted", () => {
    const p = prepare({
      source:
        "/** @ensures{p} forall (x: int) { f(x) === x } */\nexport function f(x: number): number {\n  return x / 1;\n}\n/** @ensures{q} forall (x: int) { g(x) === x } */\nexport function g(x: number): number { return x; }",
    });
    expect(p.outside.get("f")).toBe("outside the engine's subset (line 3): the / operator");
    expect(p.emitted.theorems.map((t) => t.function)).toEqual(["g"]);
  });

  test("an annotation that does not parse is reported, not silently dropped", () => {
    const p = prepare({
      source:
        "/**\n * @ensures{p} forall (x: integer) { f(x) === x }\n * @total\n */\nexport function f(x: number): number { return x; }",
    });
    expect(p.specErrors).toEqual([{ line: 2, message: expect.stringContaining("integer") }]);
    expect(p.emitted.theorems).toEqual([]);
  });

  test("an annotated function the reader cannot find at the top level is unsupported, not thrown", async () => {
    const r = await proveModule({
      source:
        "export namespace N {\n  /** @ensures{p} forall (x: int) { f(x) === x } */\n  export function f(x: number): number { return x; }\n}",
    });
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

  test("an annotation on a nested function does not attach to a top-level function of the same name", () => {
    const p = prepare({
      source:
        "export namespace N {\n  /** @total */\n  export function f(x: number): number { return x; }\n}\nexport function f(x: number): number { return x; }",
    });
    expect(p.outside.get("f")).toContain("is not the module's top-level declaration");
    expect(p.emitted.theorems).toEqual([]);
    // On one line too: declarations are told apart by position, not by line.
    const sameLine = prepare({
      source:
        "export namespace N { /** @ensures{p} forall (x: int) { f(x) === x } */ export function f(x: number): number { return x + 1; } } export function f(x: number): number { return x; }",
    });
    expect(sameLine.outside.get("f")).toContain("is not the module's top-level declaration");
    expect(sameLine.emitted.theorems).toEqual([]);
  });

  test("only the functions asked for get theorems; callees are emitted all the same", () => {
    const p = prepare({
      source: `${refund}\nexport function twice(n: number): number { return n + n; }`,
      functions: ["decideRefund"],
    });
    expect(p.emitted.theorems.map((t) => t.property)).toEqual([
      "within-captured",
      "full-refund-allowed",
    ]);
    expect(p.emitted.source).toContain("def f_twice");
  });
});

const toolchain = await findLean();
const required = process.env["EUTAXY_REQUIRE_LEAN"] === "1";

describe.skipIf("unavailable" in toolchain && !required)("proveModule with the pinned Lean", () => {
  test("proves what holds, gives up on what does not, proves @total by acceptance, leaves @throws alone", async () => {
    const r = await proveModule({ source: refund });
    expect(
      r.results.map((x) => [
        x.property,
        x.outcome.kind === "UNKNOWN" ? x.outcome.cause : x.outcome.kind,
      ]),
    ).toEqual([
      ["within-captured", "PROVEN"],
      ["full-refund-allowed", "gave_up"],
      ["@total", "PROVEN"],
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
    expect(r.lean).toMatch(/theorem t\d+_decideRefund_within_captured/);
  }, 120_000);

  test("a timeout is gave_up, never a verdict", async () => {
    const r = await proveModule({ source: refund, timeoutMs: 1 });
    expect(
      r.results.every((x) => x.outcome.kind === "UNKNOWN" && x.outcome.cause === "gave_up"),
    ).toBe(true);
  }, 30_000);
});
