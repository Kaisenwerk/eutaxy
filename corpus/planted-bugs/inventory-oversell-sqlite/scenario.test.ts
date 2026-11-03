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
  // The violating row is the stock table's, read from the object's SQL storage.
  expect(verdict.violation.keys).toEqual(['{"qty":-1,"sku":"widget"}']);
  const order = verdict.trace.entries.map((e) => `${e.kind} ${e.target} ${e.op}`);
  const secondCall = order.indexOf(
    "call DO:INVENTORY reserve",
    order.indexOf("call DO:INVENTORY reserve") + 1,
  );
  expect(secondCall).toBeGreaterThan(-1);
  expect(secondCall).toBeLessThan(order.indexOf("result Fetch:warehouse POST"));
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed inventory takes the stock before holding and holds with two in flight", async () => {
  const bindings = { INVENTORY: (env as unknown as { FIXED_INVENTORY: unknown }).FIXED_INVENTORY };
  const verdict = await check(scenario, platformFor(bindings), {
    seed: "corpus",
    budgetMs: 30_000,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
