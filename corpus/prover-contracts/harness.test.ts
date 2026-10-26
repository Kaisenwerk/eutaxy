/**
 * Every contract entry through the engine against the pinned Lean, plus
 * translation validation: the Lean definitions must compute what the
 * TypeScript computes on drawn inputs. Skipped when the toolchain is not
 * installed, unless EUTAXY_REQUIRE_LEAN is set (CI), where that is a failure.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PrngState, seedPrng } from "@eutaxy/core";
import { generate } from "@eutaxy/prover";
import {
  findLean,
  ident,
  type ProofOutcome,
  proveModule,
  readSubset,
  type SubsetType,
  value,
} from "@eutaxy/prover-lean";
import type { Binder } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";

const root = import.meta.dirname;
const entries = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "manifest.json")))
  .map((d) => d.name)
  .sort();

interface Manifest {
  readonly description: string;
  readonly expect: { readonly [fn: string]: { readonly [property: string]: string } };
}

const toolchain = await findLean();
const required = process.env["EUTAXY_REQUIRE_LEAN"] === "1";

test("the pinned Lean toolchain is installed where it is required", () => {
  if (required) expect(toolchain, JSON.stringify(toolchain)).not.toHaveProperty("unavailable");
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
          ? { name: "b", domain: "boolean" }
          : t.kind === "string"
            ? { name: "s", domain: "string" }
            : {
                name: "n",
                domain: "int",
                guard: {
                  kind: "interval",
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

describe.skipIf("unavailable" in toolchain && !required)("prover contracts", () => {
  for (const entry of entries) {
    const dir = join(root, entry);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const source = readFileSync(join(dir, "domain.ts"), "utf8");

    test(`${entry}: ${manifest.description}`, async () => {
      // Translation validation for the functions the subset accepts: Lean must agree with TypeScript on drawn inputs.
      const extra: string[] = [];
      const subset = readSubset(source);
      let checks = 0;
      let drawn = 0;
      if (subset.functions.length > 0) {
        const module = (await import(join(dir, "domain.ts"))) as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        for (const fn of subset.functions) {
          // Inputs are drawn for integer and boolean parameters of exported functions; a record parameter is not drawn yet.
          if (typeof module[fn.name] !== "function") continue;
          if (fn.params.some((p) => p.type.kind === "record")) continue;
          drawn++;
          for (const args of drawArgs(
            fn.params.map((p) => p.type),
            12,
          )) {
            const result = (module[fn.name] as (...a: unknown[]) => unknown)(...args);
            const lean = args.map((a, i) =>
              value(a, (fn.params[i] as (typeof fn.params)[number]).type, subset),
            );
            extra.push(
              `example : ${ident.fn(fn.name)}${lean.map((l) => ` ${l}`).join("")} = ${value(result, fn.returns, subset)} := by decide`,
            );
            checks++;
          }
        }
      }
      // Every entry with a function in the subset validates the translation; none may silently skip it.
      expect(checks).toBe(drawn * 12);
      const exported = source.match(/^export function (\w+)/gm)?.length ?? 0;
      expect(drawn).toBe(
        subset.functions.filter(
          (f) =>
            f.params.every((p) => p.type.kind !== "record") &&
            source.includes(`export function ${f.name}(`),
        ).length,
      );
      expect(exported).toBeGreaterThan(0);
      const proofs = await proveModule({ source, extra });
      const got: Record<string, Record<string, string>> = {};
      for (const r of proofs.results) {
        const byProperty = got[r.function] ?? {};
        byProperty[r.property] = outcomeName(r.outcome);
        got[r.function] = byProperty;
        // A compile failure of the emitted Lean (a translation check among it) is an engine bug, never a verdict.
        if (r.outcome.kind === "UNKNOWN")
          expect(r.outcome.reason, `${r.function} ${r.property}`).not.toContain("did not compile");
      }
      expect(got).toEqual(manifest.expect);
    }, 120_000);
  }
});
