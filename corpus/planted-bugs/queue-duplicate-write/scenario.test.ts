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
  const verdict = await check(scenario, platform, { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  const kinds = verdict.trace.entries.map((e) => `${e.kind}:${e.target}:${e.op}`);
  expect(kinds).toContain("fault:Queue:payments:ack");
  expect(kinds.filter((k) => k === "result:D1:DB:run").length).toBeGreaterThanOrEqual(2);
  // Shrunk to the one message that matters, with the one fault that matters.
  expect(verdict.keptEvents).toHaveLength(1);
  const kept = verdict.keptEvents[0];
  expect(verdict.schedule.faults).toHaveLength(1);
  expect(verdict.schedule.faults[0]).toMatchObject({
    invocation: `${kept}#1`,
    fault: "crash_before",
    op: "ack",
  });
  expect(verdict.shrunk.eventsRemoved).toBe(1);
  // The committed regression test is exactly what the emitter produces for this verdict.
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});
