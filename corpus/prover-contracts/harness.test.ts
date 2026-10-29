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
import { pathToFileURL } from "node:url";
import { nextInt, type PrngState, seedPrng } from "@eutaxy/core";
import { generate, type ProofOutcome, testedRung } from "@eutaxy/prover";
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
import { type Binder, isSpec } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";

const root = import.meta.dirname;
const entries = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "manifest.json")))
  .map((d) => d.name)
  .sort();

type Expected = { readonly [fn: string]: { readonly [property: string]: string } };
interface Manifest {
  readonly description: string;
  /** Per rung and engine: the TESTED rung on inputs drawn from the parameter types, then each engine. */
  readonly expect: { readonly tested: Expected; readonly lean: Expected; readonly smt: Expected };
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

/** A value of a subset type: small integers, both booleans, short strings, lists of up to three of them. */
function drawValue(t: SubsetType, state: PrngState): [unknown, PrngState] {
  if (t.kind === "list") {
    const [length, s0] = nextInt(state, 4);
    let s = s0;
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const [v, next] = drawValue(t.element, s);
      s = next;
      out.push(v);
    }
    return [out, s];
  }
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
  return generate(binder, state) as [unknown, PrngState];
}

/** Inputs drawn from the parameters' types. */
function drawArgs(types: readonly SubsetType[], count: number): unknown[][] {
  let state: PrngState = seedPrng("contracts");
  const out: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const args: unknown[] = [];
    for (const t of types) {
      const [v, next] = drawValue(t, state);
      state = next;
      args.push(v);
    }
    out.push(args);
  }
  return out;
}

/**
 * Types the translation checks draw from, per engine: records, nullable
 * types and unions are not drawn yet; lists only for the Lean engine (the
 * SMT engine does not take them).
 */
const drawable = (t: SubsetType, engine: "lean" | "smt"): boolean =>
  t.kind === "int" ||
  t.kind === "bool" ||
  t.kind === "string" ||
  (engine === "lean" && t.kind === "list" && drawable(t.element, engine));

/** The functions the translation can be validated on: in the subset, exported, every parameter drawable. */
async function drawn(dir: string, source: string, engine: "lean" | "smt") {
  const subset = readSubset(source, undefined, { path: join(dir, "domain.ts") });
  const module = (await import(join(dir, "domain.ts"))) as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  // Any result is compared, as before lists; a list result only where the engine takes lists.
  // The result must be a value the engine spells too: a drawable type or a record; a union or a
  // nullable result is not (the Lean engine takes neither, the SMT engine is not asked here).
  const valued = (t: SubsetType): boolean => drawable(t, engine) || t.kind === "record";
  const checked = (f: (typeof subset.functions)[number]) =>
    f.params.every((p) => drawable(p.type, engine)) &&
    valued(f.returns) &&
    (engine === "lean" || f.returns.kind !== "list");
  const checks: { fn: (typeof subset.functions)[number]; args: unknown[]; result: unknown }[] = [];
  let functions = 0;
  for (const fn of subset.functions) {
    if (typeof module[fn.name] !== "function") continue;
    if (!checked(fn)) continue;
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
    subset.functions.filter((f) => checked(f) && source.includes(`export function ${f.name}(`))
      .length,
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
  // Real paths: a type imported from a file beside the module resolves from where the module is.
  const modulePath = join(dir, "domain.ts");
  const source = readFileSync(modulePath, "utf8");
  const spec = readFileSync(join(dir, "domain.props.ts"), "utf8");
  const specPath = join(dir, "domain.props.ts");

  describe(`${entry}: ${manifest.description}`, () => {
    test("the spec file reads", () => {
      // A spec file that does not read is a broken entry, never a quiet unsupported.
      expect(readSpecs({ module: source, spec, modulePath }).errors).toEqual([]);
    });

    test("tested", async () => {
      // The TESTED rung on every property, the spec file loaded as the generated check loads it.
      const specs = readSpecs({ module: source, spec, modulePath });
      const props = (await import(pathToFileURL(specPath).href)) as Record<string, unknown>;
      const got: Record<string, Record<string, string>> = {};
      for (const fn of specs.functions)
        for (const property of fn.properties) {
          const exported = props[property.name];
          const verdict = testedRung({
            module: entry,
            fn,
            property,
            spec: isSpec(exported) && exported.kind === "forall" ? exported : undefined,
            seed: "contracts",
          });
          const byProperty = got[fn.name] ?? {};
          byProperty[property.name] = verdict.kind === "UNKNOWN" ? verdict.cause : verdict.kind;
          got[fn.name] = byProperty;
        }
      expect(got).toEqual(manifest.expect.tested);
    }, 60_000);

    test.skipIf("unavailable" in lean && !requireLean)(
      "lean",
      async () => {
        const specs = readSpecs({ module: source, spec, modulePath });
        const { subset, checks } = await drawn(dir, source, "lean");
        const extra = checks.map(
          ({ fn, args, result }) =>
            `example : ${leanIdent.fn(fn.name)}${args.map((a, i) => ` ${leanValue(a, (fn.params[i] as (typeof fn.params)[number]).type, subset)}`).join("")} = ${leanValue(result, fn.returns, subset)} := by decide`,
        );
        // specPath: a proof file beside the spec file supplies proofs the tactic script does not find.
        const proofs = await proveWithLean({ source, specs, extra, modulePath, specPath });
        expect(outcomes(proofs.results)).toEqual(manifest.expect.lean);
      },
      120_000,
    );

    test.skipIf("unavailable" in z3 && !requireZ3)(
      "smt",
      async () => {
        const specs = readSpecs({ module: source, spec, modulePath });
        const { subset, checks } = await drawn(dir, source, "smt");
        const extra = checks.map(({ fn, args, result }) => {
          const call =
            args.length === 0
              ? smtIdent.fn(fn.name)
              : `(${smtIdent.fn(fn.name)} ${args.map((a, i) => smtValue(a, (fn.params[i] as (typeof fn.params)[number]).type, subset)).join(" ")})`;
          return equal(call, smtValue(result, fn.returns, subset), fn.returns, subset);
        });
        const proofs = await proveWithSmt({ source, specs, modulePath, specPath, extra });
        expect(outcomes(proofs.results)).toEqual(manifest.expect.smt);
      },
      120_000,
    );
  });
}
