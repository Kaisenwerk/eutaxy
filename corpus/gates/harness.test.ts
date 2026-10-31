/** Every gate entry is complete: the files exist and at least one scenario builds and names the entry. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entries = readdirSync(here, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(here, d.name, "wrangler.jsonc")))
  .map((d) => d.name);

describe("gate corpus", () => {
  test("has at least one entry", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const name of entries) {
    describe(name, () => {
      const dir = join(here, name);
      const scenarios = readdirSync(dir).filter((f) => f.endsWith(".sim.ts"));

      test("has every required file", () => {
        for (const f of ["worker.ts", "wrangler.jsonc", "scenario.test.ts", "README.md"])
          expect(existsSync(join(dir, f)), f).toBe(true);
        expect(scenarios.length).toBeGreaterThan(0);
      });

      test("every scenario builds and points at the entry's Worker", async () => {
        for (const file of scenarios) {
          const mod = (await import(join(dir, file))) as { default: ScenarioSpec };
          expect(mod.default.version).toBe(1);
          expect(existsSync(join(dir, mod.default.worker.entry))).toBe(true);
          expect(existsSync(join(dir, mod.default.worker.config))).toBe(true);
        }
      });
    });
  }
});
