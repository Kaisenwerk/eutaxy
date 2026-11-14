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

  test("a Worker entry outside the scenario's directory is imported by name and passed as the worker", () => {
    const src = checkTestSource({
      seed: "s",
      scenarioImport: "../x.sim.ts",
      workerImport: "../../workers/orders/src/index.ts",
    });
    expect(src).toContain('import * as workerModule from "../../workers/orders/src/index.ts";');
    expect(src).toContain("specEntries, worker: workerModule, seed:");
    expect(checkTestSource({ seed: "s", scenarioImport: "../x.sim.ts" })).not.toContain(
      "workerModule",
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
    // Vite's cache goes with the generated files, not into the project's node_modules.
    expect(src).toContain('cacheDir: "/p/.eutaxy/.vite"');
    expect(src).toContain('reporters: ["json", ');
    expect(src).toContain('outputFile: "/p/.eutaxy/r.json"');
    // Errors nothing handled fail the run but are not in the JSON report: a reporter keeps them.
    expect(src).toContain('"/p/.eutaxy/r.unhandled.json"');
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

describe("a callee that is the scenario's own Worker", () => {
  test("is passed as itself: the Worker a callee calls back runs with the scenario's env", () => {
    const src = checkTestSource({
      seed: "s",
      scenarioImport: "../x.sim.ts",
      callees: [
        { binding: "TURNS", name: "turns", importPath: "../turns/worker.ts" },
        {
          binding: "turns/FRONT",
          name: "front",
          importPath: "../worker.ts",
          entrypoint: "Notices",
          self: true,
        },
      ],
    });
    expect(src).toContain(
      '"turns/FRONT": { name: "front", exports: callee_1, entrypoint: "Notices", self: true }',
    );
    expect(src).toContain('"TURNS": { name: "turns", exports: callee_0 }');
  });
});

describe("a scenario with callees", () => {
  test("the test imports each callee's module and passes it with its name; a schema outside the directory is imported by name", () => {
    const src = checkTestSource({
      seed: "s",
      scenarioImport: "../x.sim.ts",
      callees: [
        { binding: "INVENTORY", name: "inventory", importPath: "../../inventory/worker.ts" },
      ],
      sqlImports: [{ key: "../../inventory/schema.sql", importPath: "../../inventory/schema.sql" }],
    });
    expect(src).toContain('import * as callee_0 from "../../inventory/worker.ts";');
    expect(src).toContain('import sql_0 from "../../inventory/schema.sql?raw";');
    expect(src).toContain(
      'specEntries, callees: { "INVENTORY": { name: "inventory", exports: callee_0 } }, extraSql: { "../../inventory/schema.sql": sql_0 }, seed: "s" });',
    );
    const aliased = checkTestSource({
      seed: "s",
      scenarioImport: "../x.sim.ts",
      callees: [{ binding: "INVENTORY", name: "inventory", importPath: "../inventory/worker.ts" }],
      aliases: { "inventory/DB": "DB" },
    });
    expect(aliased).toContain('}, aliases: {"inventory/DB":"DB"}, seed: "s" });');
    const carried = checkTestSource({
      seed: "s",
      scenarioImport: "../x.sim.ts",
      callees: [
        {
          binding: "ORDERS",
          name: "orders",
          importPath: "../orders/worker.ts",
          entrypoint: "OrdersEntrypoint",
          props: { caller: "storefront" },
        },
      ],
    });
    expect(carried).toContain(
      '"ORDERS": { name: "orders", exports: callee_0, entrypoint: "OrdersEntrypoint", props: {"caller":"storefront"} }',
    );
  });

  test("the vitest config names the scenario's entry as the main module, so its object classes run", () => {
    const src = vitestConfigSource(
      "/p/wrangler.jsonc",
      "/p/.eutaxy/x.test.ts",
      "/p/.eutaxy/r.json",
      { main: "/p/worker.fixed.ts" },
    );
    expect(src).toContain(
      'cloudflareTest({ main: "/p/worker.fixed.ts", wrangler: { configPath: "/p/wrangler.jsonc" } })',
    );
    expect(src).not.toContain("neverCalled");
  });

  test("the vitest config names the generated main module and the callees' resources", () => {
    const src = vitestConfigSource(
      "/p/wrangler.jsonc",
      "/p/.eutaxy/x.test.ts",
      "/p/.eutaxy/r.json",
      {
        main: "/p/.eutaxy/main.1.ts",
        miniflare: '{ d1Databases: {"inventory/DB":"inv"} }',
      },
    );
    expect(src).toContain(
      'cloudflareTest({ main: "/p/.eutaxy/main.1.ts", wrangler: { configPath: "/p/wrangler.jsonc" }, miniflare: { d1Databases: {"inventory/DB":"inv"} } })',
    );
    expect(src).toContain("const neverCalled = () => new Response(");
  });
});
