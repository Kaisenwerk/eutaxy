import { describe, expect, test } from "vitest";
import { checkTestSource, metaKey, vitestConfigSource } from "./generate.ts";

describe("generated check test", () => {
  test("imports the scenario, resolves schemas and the worker by glob, and stores the verdict in task meta", () => {
    const src = checkTestSource({ seed: "s", maxRuns: 5, scenarioImport: "../x.sim.ts" });
    expect(src).toContain('import scenario from "../x.sim.ts";');
    expect(src).toContain('import.meta.glob("../**/*.sql"');
    expect(src).toContain('"!../**/*.sim.ts"');
    expect(src).toContain('check(scenario, platform, { seed: "s", maxRuns: 5 })');
    expect(src).toContain(`task.meta[${JSON.stringify(metaKey)}] =`);
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
});
