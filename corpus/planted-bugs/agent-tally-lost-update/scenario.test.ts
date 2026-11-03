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
  // The flush ran from the Agent's schedule, over the object's alarm, in virtual time.
  const order = verdict.trace.entries.map((e) => `${e.kind} ${e.target} ${e.op}`);
  expect(order).toContain("call DO:TALLY alarm");
  expect(order.indexOf("call DO:TALLY alarm")).toBeGreaterThan(
    order.lastIndexOf("result Fetch:audit POST"),
  );
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed Agent writes its state before the audit and holds with two in flight", async () => {
  const bindings = { TALLY: (env as unknown as { FIXED_TALLY: unknown }).FIXED_TALLY };
  const verdict = await check(scenario, platformFor(bindings), {
    seed: "corpus",
    budgetMs: 30_000,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
