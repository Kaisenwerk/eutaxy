import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSpecs } from "@eutaxy/prover/reader";
import { afterAll, describe, expect, test } from "vitest";
import { engineAssumptions, prepare, proveModule } from "./prove.ts";
import { findZ3 } from "./z3.ts";

const refund = `
export interface RefundDecision { readonly ok: boolean; readonly refunded: number }
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount >= captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
export function abs(x: number): number {
  return x < 0 ? -x : x;
}
`;
const refundSpecs = `
import { forall, total } from "@eutaxy/spec";
import { abs, decideRefund } from "./domain.ts";
export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(captured) && Number.isInteger(refunded) && Number.isInteger(amount) &&
    0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).refunded <= captured,
});
export const withinCapturedOverDoubles = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).refunded <= captured,
});
export const fullRefundAllowed = forall(decideRefund, {
  when: (captured, refunded, amount) => 0 <= refunded && amount > 0 && refunded + amount === captured,
  ensures: (captured, refunded, amount) => decideRefund(captured, refunded, amount).ok,
});
export const decideRefundTotal = total(decideRefund);
export const absNonNegative = forall(abs, { ensures: (x) => abs(x) >= 0 });
export const absNonNegativeOfIntegers = forall(abs, { when: (x) => Number.isInteger(x), ensures: (x) => abs(x) >= 0 });
`;
const read = (module: string, spec: string) =>
  readSpecs({ module, spec, moduleSpecifiers: ["./domain.ts"] });

describe("prepare", () => {
  test("a function outside the subset names the construct and the line; the others get scripts", () => {
    const source =
      "export function f(x: number): number {\n  return x / 1;\n}\nexport function g(x: number): number { return x; }";
    const spec =
      'import { forall } from "eutaxy/spec";\nimport { f, g } from "./domain.ts";\nexport const p = forall(f, { ensures: (x) => f(x) === x });\nexport const q = forall(g, { ensures: (x) => g(x) === x });';
    const p = prepare({ source, specs: read(source, spec) });
    expect(p.outside.get("f")).toBe("outside the engine's subset (line 2): the / operator");
    expect([...p.scripts.keys()].map((k) => k.split("\u0000")[1])).toEqual(["q"]);
  });

  test("a property the emitter cannot state is skipped with why, located in the spec file", () => {
    const source =
      "export interface R { readonly n: number }\nexport function f(r: R): R { return r; }";
    const spec =
      'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const p = forall(f, { ensures: (r) => f(r) === r });';
    const p = prepare({ source, specs: read(source, spec) });
    expect(p.skipped.get("f\u0000p")).toBe(
      "ensures (spec file line 3): === on records compares references in JavaScript; compare their fields instead",
    );
  });
});

const z3 = await findZ3();
const required = process.env["EUTAXY_REQUIRE_Z3"] === "1";
// Inside the package, so the spec file's `@eutaxy/spec` resolves when the engine loads it for replay.
const dir = mkdtempSync(join(import.meta.dirname, "..", ".probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf("unavailable" in z3 && !required)("proveModule with the pinned Z3", () => {
  test("proves over doubles where the claim holds, refutes with a replayed and shrunk model where it does not", async () => {
    writeFileSync(join(dir, "domain.ts"), refund);
    const specPath = join(dir, "domain.props.ts");
    writeFileSync(specPath, refundSpecs);
    const specs = read(refund, refundSpecs);
    expect(specs.errors).toEqual([]);
    const r = await proveModule({ source: refund, specs, specPath });
    const by = Object.fromEntries(r.results.map((x) => [x.property, x.outcome]));
    expect(by["withinCaptured"]).toMatchObject({
      kind: "PROVEN",
      engine: { name: "smt", version: "5.3.2" },
    });
    expect(by["withinCaptured"]).toMatchObject({ assumptions: engineAssumptions });
    // Over doubles the same claim fails: a NaN amount is approved with a NaN total.
    expect(by["withinCapturedOverDoubles"]).toMatchObject({ kind: "REFUTED" });
    if (by["withinCapturedOverDoubles"]?.kind === "REFUTED")
      expect(by["withinCapturedOverDoubles"].counterexample?.binders.map((b) => b.value)).toEqual([
        "0",
        "0",
        "NaN",
      ]);
    expect(by["fullRefundAllowed"]).toMatchObject({ kind: "REFUTED" });
    expect(by["decideRefundTotal"]).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    expect(by["absNonNegative"]).toMatchObject({
      kind: "REFUTED",
      counterexample: { binders: [{ name: "x", value: "NaN" }] },
    });
    expect(by["absNonNegativeOfIntegers"]).toMatchObject({ kind: "PROVEN" });
    expect(r.smt).toContain("(define-fun f_decideRefund");
  }, 120_000);

  test("without the spec file's path a model is a modelling gap, never a verdict; a resource limit reached is gave_up", async () => {
    const specs = read(refund, refundSpecs);
    const r = await proveModule({ source: refund, specs, functions: ["abs"] });
    const abs = r.results.find((x) => x.property === "absNonNegative")?.outcome;
    expect(abs).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
    if (abs?.kind === "UNKNOWN") expect(abs.reason).toContain("the model: x = NaN");
    const tight = await proveModule({
      source: refund,
      specs,
      functions: ["decideRefund"],
      resourceLimit: 100,
    });
    expect(
      tight.results
        .filter((x) => x.property !== "decideRefundTotal")
        .every((x) => x.outcome.kind === "UNKNOWN" && x.outcome.cause === "gave_up"),
    ).toBe(true);
  }, 120_000);

  test("a translation check that fails marks every result unsupported", async () => {
    const specs = read(refund, refundSpecs);
    const r = await proveModule({
      source: refund,
      specs,
      functions: ["abs"],
      extra: [
        "(fp.eq (f_abs (_ +zero 11 53)) (_ +zero 11 53))",
        "(fp.eq (f_abs (_ +zero 11 53)) (_ NaN 11 53))",
      ],
    });
    for (const x of r.results) {
      expect(x.outcome).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
      if (x.outcome.kind === "UNKNOWN")
        expect(x.outcome.reason).toContain("failed a translation check");
    }
  }, 60_000);
});

describe("review findings, with the pinned Z3", () => {
  test.skipIf("unavailable" in z3 && !required)(
    "replays a spec file that imports its module without the extension",
    async () => {
      const source =
        'export function pick(s: "a" | "b"): "a" | "b" { return s; }\nexport function id(x: number): number { return x; }';
      writeFileSync(join(dir, "m.ts"), source);
      const specPath = join(dir, "m.props.ts");
      writeFileSync(
        specPath,
        'import { forall } from "@eutaxy/spec";\nimport { id, pick } from "./m";\nexport const literals = forall(pick, { ensures: (s) => pick(s) === "a" || pick(s) === "b" });\nexport const identity = forall(id, { ensures: (x) => id(x) === x });',
      );
      const specs = readSpecs({
        module: source,
        spec: readFileSync(specPath, "utf8"),
        moduleSpecifiers: ["./m.ts", "./m"],
      });
      expect(specs.errors).toEqual([]);
      const r = await proveModule({ source, specs, specPath });
      const by = Object.fromEntries(r.results.map((x) => [x.property, x.outcome]));
      // The literal union is constrained, so the claim is proved rather than refuted by an empty string.
      expect(by["literals"]).toMatchObject({ kind: "PROVEN" });
      // NaN !== NaN: refuted, with the model replayed through the spec file loaded despite the bare import.
      expect(by["identity"]).toMatchObject({
        kind: "REFUTED",
        counterexample: { binders: [{ name: "x", value: "NaN" }] },
      });
    },
    120_000,
  );

  test.skipIf("unavailable" in z3 && !required)(
    "the pinned solver is found behind another version on the PATH",
    async () => {
      const fake = join(dir, "z3-old");
      writeFileSync(fake, '#!/bin/sh\necho "Z3 version 4.13.0 - 64 bit"\n', { mode: 0o755 });
      const real = await findZ3();
      if ("unavailable" in real) return;
      expect(await findZ3([fake, real.command])).toEqual(real);
      expect(await findZ3([fake])).toMatchObject({
        unavailable: expect.stringContaining("z3 4.13.0 found"),
      });
    },
  );
});
