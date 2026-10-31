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
