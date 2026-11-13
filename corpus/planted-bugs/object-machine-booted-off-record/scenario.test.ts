/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { machines } from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: {},
    exports: worker,
    durableObjects: cloudflareTest,
  });
const fixed = machines("SAFE_POOL");

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One fault, on the pool's own call into the scripted machine, inside the Worker's call.
  expect(verdict.schedule.faults).toHaveLength(1);
  expect(verdict.schedule.faults[0]).toMatchObject({
    invocation: "start-a#1",
    target: "DO:MACHINE",
    op: "boot",
  });
  expect(["crash_after", "ambiguous"]).toContain(verdict.schedule.faults[0]?.fault);
  // The machine booted: its answer is on record, and then the fault.
  const boot = verdict.trace.entries
    .filter((e) => e.target === "DO:MACHINE" && e.op === "boot")
    .map((e) => e.kind);
  expect(boot).toEqual(["call", "result", "fault"]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed pool claims the job before the boot leaves, and no machine runs off the record", async () => {
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
