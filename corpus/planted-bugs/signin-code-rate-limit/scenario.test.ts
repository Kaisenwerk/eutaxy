/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // No fault, both requests kept, and both reads before either insert.
  expect(verdict.schedule.faults).toEqual([]);
  expect(verdict.keptEvents).toEqual(["req-1", "req-2"]);
  const calls = verdict.trace.entries
    .filter((e) => e.kind === "call" && e.target === "D1:DB")
    .map((e) => e.op);
  expect(calls).toEqual(["first", "first", "run", "run"]);
  // Each request's effects are attributed to its own invocation.
  const inserts = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "run");
  expect(inserts.map((e) => e.invocation).sort()).toEqual(["req-1#1", "req-2#1"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("one request at a time, the limit holds", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const sequential = {
    ...scenario,
    bounds: { ...scenario.bounds, maxConcurrentInvocations: 1 },
  };
  const verdict = await check(sequential, platform, { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
