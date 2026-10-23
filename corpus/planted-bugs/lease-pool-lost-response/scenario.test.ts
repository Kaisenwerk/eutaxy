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
  const verdict = await check(scenario, platformFor(env), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  expect(verdict.schedule.faults.map((f) => `${f.op} ${f.fault}`)).toEqual(["acquire ambiguous"]);
  const calls = verdict.trace.entries.filter((e) => e.kind === "call" && e.target === "DO:POOL");
  expect(calls.map((e) => e.op)).toEqual(["acquire", "acquire"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed pool returns the existing lease to the retry and holds", async () => {
  // The same Worker and scenario, with POOL bound to the fixed class.
  const bindings = { POOL: (env as unknown as { FIXED_POOL: unknown }).FIXED_POOL };
  const verdict = await check(scenario, platformFor(bindings), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
