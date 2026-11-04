import { emptyLog, type Violated } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { cloudflareRegressionTest } from "./regression.ts";

const verdict: Violated = {
  kind: "VIOLATED",
  scenario: "s",
  seed: 1,
  violation: { invariant: "inv", message: "m", keys: ['"k"'], evidence: [] },
  trace: emptyLog,
  schedule: { seed: 2, faults: [] },
  keptEvents: ["msg-1"],
  shrunk: { faultsRemoved: 0, eventsRemoved: 0, runs: 0 },
  reached: { runs: 1, effectPoints: 0, faultsInjected: 0, elapsedMs: 0 },
  assumptions: [],
};

describe("cloudflareRegressionTest", () => {
  test("imports the scenario, worker and schemas and builds the platform", () => {
    const src = cloudflareRegressionTest(verdict, {
      scenarioPath: "./scenario.sim.js",
      workerPath: "./worker.js",
      schemaPaths: { DB: "./schema.sql", AUDIT: "./audit.sql" },
    });
    expect(src).toContain('import schema_AUDIT from "./audit.sql?raw";');
    expect(src).toContain('import schema_DB from "./schema.sql?raw";');
    expect(src).toContain(
      "createCloudflarePlatform({ env, handler, schemas: { AUDIT: schema_AUDIT, DB: schema_DB } })",
    );
    expect(src).not.toContain("maxRetries");
  });

  test("passes the Worker module's exports when asked (Workflows set up, a named entrypoint driven)", () => {
    for (const flag of [{ exports: true }, { workflows: true }]) {
      const src = cloudflareRegressionTest(verdict, {
        scenarioPath: "./scenario.sim.js",
        workerPath: "./worker.js",
        schemaPaths: {},
        ...flag,
      });
      expect(src).toContain('import * as worker from "./worker.js";');
      expect(src).toContain(
        "createCloudflarePlatform({ env, handler: worker.default, schemas: {  }, exports: worker })",
      );
    }
  });

  test("reproduces a non-default retry limit", () => {
    const src = cloudflareRegressionTest(verdict, {
      scenarioPath: "./scenario.sim.js",
      workerPath: "./worker.js",
      schemaPaths: {},
      maxRetries: 0,
    });
    expect(src).toContain(
      "createCloudflarePlatform({ env, handler, schemas: {  }, maxRetries: 0 })",
    );
  });

  test("replays under the time budget the check ran with, when it replaced the scenario's", () => {
    const options = { scenarioPath: "./s.sim.js", workerPath: "./w.js", schemaPaths: {} };
    expect(cloudflareRegressionTest(verdict, options)).toContain(
      "restrictSpec(platform, scenario, keptEvents)",
    );
    expect(cloudflareRegressionTest(verdict, { ...options, budgetMs: 60000 })).toContain(
      "restrictSpec(platform, { ...scenario, bounds: { ...scenario.bounds, budgetMs: 60000 } }, keptEvents)",
    );
  });
});

test("callees are imported as modules and passed with their names; qualified binding names are quoted keys", () => {
  const text = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql", "inventory/DB": "./inventory/schema.sql" },
    callees: { INVENTORY: { name: "inventory", path: "./inventory/worker.ts" } },
    expect: "violates",
  });
  expect(text).toContain('import schema_inventory_DB from "./inventory/schema.sql?raw";');
  expect(text).toContain('import * as callee_INVENTORY from "./inventory/worker.ts";');
  expect(text).toContain(
    'schemas: { DB: schema_DB, "inventory/DB": schema_inventory_DB }, callees: { INVENTORY: { name: "inventory", exports: callee_INVENTORY } }',
  );
  expect(text).not.toContain("Needs the callees' bindings");
  const noted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    callees: { INVENTORY: { name: "inventory", path: "./inventory/worker.ts" } },
    calleeBindings: ["inventory/DB", "inventory/LEASES"],
  });
  expect(noted.split("\n")[3]).toBe(
    "// Needs the callees' bindings in this test's isolate under their qualified names: inventory/DB, inventory/LEASES.",
  );
});

test("two binding names that map to one identifier get distinct import names", () => {
  const text = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { "orders/DB": "./orders/schema.sql", orders_DB: "./other.sql" },
  });
  expect(text).toContain('import schema_orders_DB from "./orders/schema.sql?raw";');
  expect(text).toContain('import schema_orders_DB_2 from "./other.sql?raw";');
  expect(text).toContain('schemas: { "orders/DB": schema_orders_DB, orders_DB: schema_orders_DB_2 }');
});
