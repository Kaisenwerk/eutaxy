/**
 * Every package test of the real runtime (`packages/<name>/workerd/<test>`)
 * is complete: a README saying what its Worker exercises, and scenarios
 * that build and point at a Worker and a config that exist. The tests pass
 * the handler to the platform themselves, so a scenario's own `worker`
 * would otherwise go unchecked until `eutaxy check` ran it. (A directory
 * without its `wrangler.jsonc` stops Vitest itself: `vitest.config.ts`.)
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { root } from "./eutaxy-command.ts";

/** What is read of a scenario: the tests cannot import the core's types by name. */
interface Scenario {
  readonly version: number;
  readonly worker: { readonly entry: string; readonly config: string };
}

const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((p) => p.isDirectory() && existsSync(join(root, "packages", p.name, "workerd")))
  .flatMap((p) => {
    const workerd = join(root, "packages", p.name, "workerd");
    return readdirSync(workerd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !["dist", "node_modules"].includes(d.name))
      .map((d) => ({ name: `${p.name}/workerd/${d.name}`, dir: join(workerd, d.name) }));
  });

describe("the packages' workerd tests", () => {
  test("there are some", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const { name, dir } of dirs) {
    test(`${name}: a README, and scenarios pointing at files that exist`, async () => {
      expect(existsSync(join(dir, "README.md")), "README.md").toBe(true);
      const scenarios = readdirSync(dir).filter((f) => f.endsWith(".sim.ts"));
      expect(scenarios.length).toBeGreaterThan(0);
      for (const file of scenarios) {
        const mod = (await import(join(dir, file))) as { default: Scenario };
        expect(mod.default.version, file).toBe(1);
        expect(existsSync(join(dir, mod.default.worker.entry)), `${file}: worker.entry`).toBe(true);
        expect(existsSync(join(dir, mod.default.worker.config)), `${file}: worker.config`).toBe(
          true,
        );
      }
    });
  }
});
