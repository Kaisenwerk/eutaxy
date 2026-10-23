/** Runs inside workerd under the Cloudflare Vitest plugin. No bindings: the external is scripted. */

import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: {} });
  const verdict = await check(scenario, platform, { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  const charges = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "Fetch:payments",
  );
  expect(charges).toHaveLength(2);
  for (const c of charges) {
    expect((c.payload as { result: { effective: boolean; status: number } }).result).toEqual({
      status: 201,
      effective: true,
      dedupeKey: null,
    });
  }
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});
