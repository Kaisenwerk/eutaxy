import { describe, expect, test } from "vitest";
import { checkTestSource, metaKey, vitestConfigSource } from "./generate.ts";

describe("generated check test", () => {
  test("imports the scenario, resolves schemas and the worker by glob, and stores the verdict in task meta", () => {
    const src = checkTestSource({ seed: "s", maxRuns: 5, scenarioImport: "../x.sim.ts" });
    expect(src).toContain('import scenario from "../x.sim.ts";');
    expect(src).toContain('import.meta.glob("../**/*.sql"');
    expect(src).toContain('"!../**/*.sim.ts"');
    expect(src).toContain(
      `task.meta[${JSON.stringify(metaKey)}] = await checkInWorkerd({ scenario, env, durableObjects, sqlFiles, modules, specEntries, seed: "s", maxRuns: 5 });`,
    );
  });

  test("passes the time budget through when one is given", () => {
    const src = checkTestSource({ seed: "s", budgetMs: 60_000, scenarioImport: "../x.sim.ts" });
    expect(src).toContain('seed: "s", budgetMs: 60000 });');
  });

  test("the vitest config points the Cloudflare plugin at the wrangler file", () => {
    const src = vitestConfigSource(
      "/p/wrangler.jsonc",
      "/p/.eutaxy/x.check.test.ts",
      "/p/.eutaxy/r.json",
    );
    expect(src).toContain('cloudflareTest({ wrangler: { configPath: "/p/wrangler.jsonc" } })');
    expect(src).toContain('include: ["/p/.eutaxy/x.check.test.ts"]');
    expect(src).toContain('reporters: ["json"]');
    expect(src).toContain('outputFile: "/p/.eutaxy/r.json"');
  });

  test("holds no logic: the globs and one typed call, importing only checkInWorkerd from eutaxy", () => {
    const src = checkTestSource({ seed: "s", scenarioImport: "../x.sim.ts" });
    expect(src.match(/from "eutaxy[^"]*"/g)).toEqual(['from "eutaxy/cloudflare"']);
    expect(src).toContain('import { checkInWorkerd } from "eutaxy/cloudflare";');
    expect(src).not.toMatch(/\bfor \(|\bif \(/);
  });

  test("an exhaustive check asks explore for every schedule", () => {
    const src = checkTestSource({ seed: "s", exhaustive: true, scenarioImport: "../x.sim.ts" });
    expect(src).toContain('seed: "s", exhaustive: true });');
  });
});
