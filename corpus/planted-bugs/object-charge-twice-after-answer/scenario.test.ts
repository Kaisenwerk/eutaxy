/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { billing } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });
const fixed = billing("SAFE_RUNNER");

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One fault, on the object's own call to billing, made in its work after the answer.
  expect(verdict.schedule.faults).toHaveLength(1);
  expect(verdict.schedule.faults[0]).toMatchObject({
    invocation: "DO:RUNNER/r/after",
    target: "Service:BILLING",
    op: "charge",
  });
  // Both charges are the object's: the job's after the answer, and the watchdog alarm's.
  const charges = verdict.trace.entries
    .filter((e) => e.kind === "call" && e.target === "Service:BILLING")
    .map((e) => e.invocation);
  expect(charges).toHaveLength(2);
  expect(charges[0]).toBe("DO:RUNNER/r/after");
  expect(charges[1]).toMatch(/^alarm:/);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed object claims the run before the charge leaves, and no run is charged twice", async () => {
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
