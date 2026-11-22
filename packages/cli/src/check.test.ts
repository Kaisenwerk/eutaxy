import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpecVerdict } from "@eutaxy/core";
import type { Prover } from "@eutaxy/prover";
import { afterAll, describe, expect, test } from "vitest";
import { consoleOutput, needsObjectHelpers, proveSpecs } from "./check.ts";

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

describe("consoleOutput", () => {
  const dir = mkdtempSync(join(tmpdir(), "eutaxy-console-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const line = (type: string, content: string) => `${JSON.stringify({ type, content })}\n`;

  test("what was written, as Vitest reported it, whichever stream it went to", () => {
    const file = join(dir, "r.console.jsonl");
    writeFileSync(
      file,
      line("stdout", "front: received\n") +
        line("stderr", "notes: refused\n") +
        line("stdout", "two\nlines\n"),
    );
    expect(consoleOutput(file)).toBe(
      "Console output during the check, every run, as Vitest reported it:\nfront: received\nnotes: refused\ntwo\nlines\n",
    );
  });

  test("colour escapes a console adds to an object it prints are removed", () => {
    const file = join(dir, "colour.console.jsonl");
    const esc = String.fromCharCode(27);
    writeFileSync(
      file,
      line("stdout", `{ a: ${esc}[33m1${esc}[39m, b: ${esc}[1;32m'x'${esc}[0m }\n`),
    );
    expect(consoleOutput(file)).toBe(
      "Console output during the check, every run, as Vitest reported it:\n{ a: 1, b: 'x' }\n",
    );
  });

  test("a last write without a line end still ends the output with one", () => {
    const file = join(dir, "open.console.jsonl");
    writeFileSync(file, line("stdout", "no newline"));
    expect(consoleOutput(file).endsWith("no newline\n")).toBe(true);
  });

  test("nothing written, or no file at all, says so", () => {
    const empty = join(dir, "empty.console.jsonl");
    writeFileSync(empty, "");
    const none = "Nothing was written to the console during the check.\n";
    expect(consoleOutput(empty)).toBe(none);
    expect(consoleOutput(join(dir, "missing.console.jsonl"))).toBe(none);
  });
});

describe("needsObjectHelpers", () => {
  test("a regression test gets the test helpers for real objects and for a scripted namespace, not otherwise", () => {
    expect(needsObjectHelpers([{ kind: "d1" }, { kind: "durable_object" }])).toBe(true);
    expect(needsObjectHelpers([{ kind: "scripted_object" }])).toBe(true);
    expect(needsObjectHelpers([{ kind: "d1" }, { kind: "service" }])).toBe(false);
  });
});
