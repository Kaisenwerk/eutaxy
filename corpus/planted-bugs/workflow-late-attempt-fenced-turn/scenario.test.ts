/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { turn } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });
const fixed = turn("SAFE_CHAT");

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    maxRuns: 400,
  });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // The start outlived the step's timeout from its start, and the turn was abandoned while it ran on.
  const faults = verdict.schedule.faults.map((f) => `${f.fault} ${f.target} ${f.op}`);
  expect(faults).toEqual(["ambiguous Workflow:TURNS step"]);
  const ops = verdict.trace.entries.map((e) => `${e.kind} ${e.target} ${e.op}`);
  expect(ops).toContain("result DO:CHAT abandonTurn");
  expect(ops).toContain("result Workflow:TURNS late_result");
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    workflows: true,
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed object's second fence check makes the late start harmless", async () => {
  const verdict = await check(fixed, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    maxRuns: 400,
  });
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
