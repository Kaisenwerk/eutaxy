import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecVerdict } from "@eutaxy/core";
import type { Prover } from "@eutaxy/prover";
import { afterAll, describe, expect, test } from "vitest";
import { proveSpecs } from "./check.ts";

const dir = mkdtempSync(join(tmpdir(), "eutaxy-prove-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("proveSpecs", () => {
  test("matches observed modules to verdicts by normalized key and passes only the functions with specs", async () => {
    writeFileSync(join(dir, "domain.ts"), "export function f(x: number): number { return x; }");
    writeFileSync(
      join(dir, "domain.props.ts"),
      'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const p = forall(f, { ensures: (x) => f(x) === x });',
    );
    const seen: unknown[] = [];
    const fake: Prover = {
      name: "fake",
      available: async () => ({ version: "1" }),
      prove: async (input) => {
        seen.push(input.functions);
        expect(input.specs.functions.map((fn) => fn.name)).toEqual(["f"]);
        return {
          results: [
            {
              function: "f",
              property: "p",
              outcome: {
                kind: "PROVEN",
                engine: { name: "fake", version: "1" },
                assumptions: ["a"],
              },
            },
          ],
          specErrors: [],
        };
      },
    };
    const tested: SpecVerdict = {
      module: "./domain.ts",
      function: "f",
      property: "p",
      text: "forall (x: int) { f(x) === x }",
      kind: "TESTED",
      inputs: 100,
      discarded: 0,
      seed: "s",
      assumptions: [],
    };
    // The scenario wrote "domain.ts" and also observes a refines decision, g, which has no specs.
    const out = await proveSpecs(
      dir,
      // Written with a backslash, as a scenario on Windows might: the key normalizes it for the read too.
      [{ module: ".\\domain.ts", functions: ["f", "g"] }],
      [tested],
      [fake],
    );
    expect(seen).toEqual([["f"]]);
    expect(out[0]).toMatchObject({ kind: "PROVEN", engine: { name: "fake" }, tested: 100 });
  });
});
