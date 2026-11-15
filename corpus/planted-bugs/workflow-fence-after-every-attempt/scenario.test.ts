/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { anywhere, turn } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });

test("with faults anywhere, sampling three faults a run does not reach it in 200 runs", async () => {
  // Some 19 points a run take a fault; the bug needs one on each of the three attempts of one step.
  const verdict = await check(anywhere, platform(), {
    seed: "corpus",
    budgetMs: 120_000,
    maxRuns: 200,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test(`with faults on the step's attempts only, exhaustive exploration reaches ${manifest.expect.verdict} on ${manifest.expect.invariant} at once`, async () => {
  const verdict = await check(scenario, platform(), {
    seed: "corpus",
    budgetMs: 30_000,
    exhaustive: true,
  });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  expect(verdict.reached.runs).toBeLessThan(30);
  expect(verdict.assumptions).toContain(
    'faults only where the scenario\'s bounds say: any fault at Workflow:TURNS where {"args.step":"start turn"}; redelivery per the platform\'s queue model',
  );
  // Each attempt failed, the last by outliving its timeout: it runs on while the turn is abandoned.
  const faults = verdict.schedule.faults.map((f) => `${f.fault} ${f.target} ${f.op}`);
  expect(faults).toHaveLength(3);
  expect(faults.at(-1)).toBe("ambiguous Workflow:TURNS step");
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

test("the fixed object's second fence check holds where sampling with the same sites finds the planted one", async () => {
  const options = { seed: "corpus", budgetMs: 120_000, maxRuns: 300 } as const;
  // Its full space at two in flight is too large to run, so the fix is held to what finds the bug.
  const planted = await check(scenario, platform(), options);
  expect(planted.kind, renderText(planted)).toBe("VIOLATED");
  const verdict = await check(turn("SAFE_CHAT", true), platform(), options);
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
