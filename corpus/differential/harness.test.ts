/** Every differential entry must be complete; the agreement itself is asserted inside workerd. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "wrangler.jsonc")))
  .map((d) => d.name);

describe("differential corpus", () => {
  test("has at least one entry", () => {
    expect(entries.length).toBeGreaterThan(0);
  });
  for (const name of entries) {
    test(`${name} has every required file`, () => {
      for (const f of [
        "worker.ts",
        "wrangler.jsonc",
        "scenario.sim.ts",
        "differential.test.ts",
        "README.md",
      ]) {
        expect(existsSync(join(here, name, f)), f).toBe(true);
      }
    });
  }
});
