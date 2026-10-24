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
  expect(verdict.schedule.faults).toEqual([]);
  // The second withdrawal starts before the first one's payout returns.
  const order = verdict.trace.entries.map((e) => `${e.kind} ${e.target} ${e.op}`);
  const secondCall = order.indexOf(
    "call DO:WALLET withdraw",
    order.indexOf("call DO:WALLET withdraw") + 1,
  );
  expect(secondCall).toBeGreaterThan(-1);
  expect(secondCall).toBeLessThan(order.indexOf("result Fetch:payouts POST"));
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("one withdrawal at a time, the balance holds", async () => {
  const sequential = { ...scenario, bounds: { ...scenario.bounds, maxConcurrentInvocations: 1 } };
  const verdict = await check(sequential, platformFor(env), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("the fixed wallet reserves before paying out and holds with two in flight", async () => {
  const bindings = { WALLET: (env as unknown as { FIXED_WALLET: unknown }).FIXED_WALLET };
  const verdict = await check(scenario, platformFor(bindings), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("a wallet that holds the input gate with blockConcurrencyWhile holds too", async () => {
  const bindings = { WALLET: (env as unknown as { GATED_WALLET: unknown }).GATED_WALLET };
  const verdict = await check(scenario, platformFor(bindings), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("exhaustive exploration finds the race, and every schedule of the fixed wallet holds", async () => {
  const buggy = await check(scenario, platformFor(env), { seed: "corpus", exhaustive: true });
  expect(buggy.kind, renderText(buggy)).toBe("VIOLATED");
  const bindings = { WALLET: (env as unknown as { FIXED_WALLET: unknown }).FIXED_WALLET };
  const fixed = await check(scenario, platformFor(bindings), { seed: "corpus", exhaustive: true });
  expect(fixed.kind, renderText(fixed)).toBe("BOUNDED");
  expect(fixed.reached.exhaustive?.complete).toBe(true);
});
