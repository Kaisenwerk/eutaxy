/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

const platformFor = (bindings: object) =>
  createCloudflarePlatform({ env: bindings, handler, schemas: {}, durableObjects: cloudflareTest });

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platformFor(env), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  expect(verdict.schedule.faults).toEqual([]);
  // Both model calls are the object's own work after the answers.
  const calls = verdict.trace.entries.filter(
    (e) => e.kind === "call" && e.target === "Fetch:model",
  );
  expect(
    calls.map((e) => e.invocation),
    verdict.trace.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`).join("\n"),
  ).toEqual(["DO:RUNNER/r/after", "DO:RUNNER/r/after"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed object adds the steps in one statement and holds", async () => {
  const bindings = { RUNNER: (env as unknown as { FIXED_RUNNER: unknown }).FIXED_RUNNER };
  const verdict = await check(scenario, platformFor(bindings), {
    seed: "corpus",
    budgetMs: 30_000,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
