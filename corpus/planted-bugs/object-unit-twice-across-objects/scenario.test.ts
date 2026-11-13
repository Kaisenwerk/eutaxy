/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { takes } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });
const fixed = takes("SAFE_SHELF");

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One fault, on the cart's own call into the shelf, made inside the call the cart is serving.
  expect(verdict.schedule.faults).toHaveLength(1);
  expect(verdict.schedule.faults[0]).toMatchObject({
    invocation: "add-1#1",
    target: "DO:SHELF",
    op: "take",
  });
  // Both takes are the cart's: one in the request, one in the caller's resend of it.
  const taken = verdict.trace.entries
    .filter((e) => e.kind === "call" && e.target === "DO:SHELF")
    .map((e) => e.invocation);
  expect(taken).toEqual(["add-1#1", "add-1#2"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed shelf keys a take by the cart, and no cart is given two units", async () => {
  const verdict = await check(fixed, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("exhaustive exploration finds it too, and every schedule of the fix holds", async () => {
  const buggy = await check(scenario, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(buggy.kind, renderText(buggy)).toBe("VIOLATED");
  const holds = await check(fixed, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(holds.kind, renderText(holds)).toBe("BOUNDED");
  expect(holds.reached.exhaustive?.complete).toBe(true);
});
