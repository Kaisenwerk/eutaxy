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

const virtualEpoch = Date.UTC(2026, 0, 1);

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // Two committed inserts for one order, each with its own UUID and a virtual timestamp.
  const inserts = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "D1:DB" && e.op === "run",
  );
  expect(inserts).toHaveLength(2);
  const params = inserts.map(
    (e) => (e.payload as { args: { params: [string, string, number, number] } }).args.params,
  );
  expect(params[0]?.[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(params[0]?.[0]).not.toBe(params[1]?.[0]);
  expect(params[0]?.[1]).toBe(params[1]?.[1]);
  for (const p of params) {
    expect(p[3]).toBeGreaterThanOrEqual(virtualEpoch);
    expect(p[3]).toBeLessThan(virtualEpoch + 1000);
  }
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});
