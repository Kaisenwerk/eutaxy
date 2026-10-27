/**
 * Every contract entry through both first-party engines against the pinned
 * Lean and Z3, plus translation validation: the Lean definitions must
 * compute what the TypeScript computes on drawn inputs, and so must the
 * SMT definitions. Each entry's manifest names the expected outcome per
 * engine: the two differ where a claim holds over the integers and fails
 * over doubles (NaN, the infinities, -0), which is what the SMT engine is
 * for. Skipped when a toolchain is not installed, unless
 * EUTAXY_REQUIRE_LEAN or EUTAXY_REQUIRE_Z3 is set (CI), where that is a
 * failure.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PrngState, seedPrng } from "@eutaxy/core";
import { generate, type ProofOutcome } from "@eutaxy/prover";
import { readSpecs, readSubset, type SubsetType } from "@eutaxy/prover/reader";
import {
  findLean,
  ident as leanIdent,
  value as leanValue,
  proveModule as proveWithLean,
} from "@eutaxy/prover-lean";
import {
  equal,
  findZ3,
  proveModule as proveWithSmt,
  ident as smtIdent,
  value as smtValue,
} from "@eutaxy/prover-smt";
import type { Binder } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";

const root = import.meta.dirname;
const entries = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "manifest.json")))
  .map((d) => d.name)
  .sort();

type Expected = { readonly [fn: string]: { readonly [property: string]: string } };
interface Manifest {
  readonly description: string;
  readonly expect: { readonly lean: Expected; readonly smt: Expected };
}

const lean = await findLean();
const z3 = await findZ3();
const requireLean = process.env["EUTAXY_REQUIRE_LEAN"] === "1";
const requireZ3 = process.env["EUTAXY_REQUIRE_Z3"] === "1";

test("the pinned toolchains are installed where they are required", () => {
  if (requireLean) expect(lean, JSON.stringify(lean)).not.toHaveProperty("unavailable");
  if (requireZ3) expect(z3, JSON.stringify(z3)).not.toHaveProperty("unavailable");
});

const outcomeName = (o: ProofOutcome): string => (o.kind === "UNKNOWN" ? o.cause : o.kind);

/** Inputs drawn from a parameter's type: small integers, both booleans, short strings. */
function drawArgs(types: readonly SubsetType[], count: number): unknown[][] {
  let state: PrngState = seedPrng("contracts");
  const out: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const args: unknown[] = [];
    for (const t of types) {
      const binder: Binder =
        t.kind === "bool"
          ? { name: "b", type: { kind: "boolean" } }
          : t.kind === "string"
            ? { name: "s", type: { kind: "string" } }
            : {
                name: "n",
                type: { kind: "number" },
                hint: {
                  integer: true,
                  lower: { value: "-50", inclusive: true },
                  upper: { value: "50", inclusive: true },
                },
              };
      const [v, next] = generate(binder, state);
      state = next;
      args.push(v);
    }
    out.push(args);
  }
  return out;
}

/** The functions the translation can be validated on: in the subset, exported, no record parameter (not drawn yet). */
async function drawn(dir: string, source: string) {
  const subset = readSubset(source);
  const module = (await import(join(dir, "domain.ts"))) as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const checks: { fn: (typeof subset.functions)[number]; args: unknown[]; result: unknown }[] = [];
  let functions = 0;
  for (const fn of subset.functions) {
    if (typeof module[fn.name] !== "function") continue;
    if (fn.params.some((p) => p.type.kind === "record")) continue;
    functions++;
    for (const args of drawArgs(
      fn.params.map((p) => p.type),
      12,
    ))
      checks.push({ fn, args, result: (module[fn.name] as (...a: unknown[]) => unknown)(...args) });
  }
  // Every entry with a function in the subset validates the translation; none may silently skip it.
  expect(checks.length).toBe(functions * 12);
  expect(functions).toBe(
    subset.functions.filter(
      (f) =>
        f.params.every((p) => p.type.kind !== "record") &&
        source.includes(`export function ${f.name}(`),
    ).length,
  );
  expect(source.match(/^export function (\w+)/gm)?.length ?? 0).toBeGreaterThan(0);
  return { subset, checks };
}

function outcomes(
  results: readonly { function: string; property: string; outcome: ProofOutcome }[],
) {
  const got: Record<string, Record<string, string>> = {};
  for (const r of results) {
    const byProperty = got[r.function] ?? {};
    byProperty[r.property] = outcomeName(r.outcome);
    got[r.function] = byProperty;
    // A failed translation check or a compile failure is an engine bug, never a verdict.
    if (r.outcome.kind === "UNKNOWN") {
      expect(r.outcome.reason, `${r.function} ${r.property}`).not.toContain("did not compile");
      expect(r.outcome.reason, `${r.function} ${r.property}`).not.toContain("translation check");
    }
  }
  return got;
}

for (const entry of entries) {
  const dir = join(root, entry);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const source = readFileSync(join(dir, "domain.ts"), "utf8");
  const spec = readFileSync(join(dir, "domain.props.ts"), "utf8");
  const specPath = join(dir, "domain.props.ts");

  describe(`${entry}: ${manifest.description}`, () => {
    test("the spec file reads", () => {
      // A spec file that does not read is a broken entry, never a quiet unsupported.
      expect(readSpecs({ module: source, spec, moduleSpecifiers: ["./domain.ts"] }).errors).toEqual(
        [],
      );
    });

    test.skipIf("unavailable" in lean && !requireLean)(
      "lean",
      async () => {
        const specs = readSpecs({ module: source, spec, moduleSpecifiers: ["./domain.ts"] });
        const { subset, checks } = await drawn(dir, source);
        const extra = checks.map(
          ({ fn, args, result }) =>
            `example : ${leanIdent.fn(fn.name)}${args.map((a, i) => ` ${leanValue(a, (fn.params[i] as (typeof fn.params)[number]).type, subset)}`).join("")} = ${leanValue(result, fn.returns, subset)} := by decide`,
        );
        const proofs = await proveWithLean({ source, specs, extra });
        expect(outcomes(proofs.results)).toEqual(manifest.expect.lean);
      },
      120_000,
    );

    test.skipIf("unavailable" in z3 && !requireZ3)(
      "smt",
      async () => {
        const specs = readSpecs({ module: source, spec, moduleSpecifiers: ["./domain.ts"] });
        const { subset, checks } = await drawn(dir, source);
        const extra = checks.map(({ fn, args, result }) => {
          const call =
            args.length === 0
              ? smtIdent.fn(fn.name)
              : `(${smtIdent.fn(fn.name)} ${args.map((a, i) => smtValue(a, (fn.params[i] as (typeof fn.params)[number]).type, subset)).join(" ")})`;
          return equal(call, smtValue(result, fn.returns, subset), fn.returns, subset);
        });
        const proofs = await proveWithSmt({ source, specs, specPath, extra });
        expect(outcomes(proofs.results)).toEqual(manifest.expect.smt);
      },
      120_000,
    );
  });
}
