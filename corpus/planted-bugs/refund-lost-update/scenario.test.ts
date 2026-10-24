/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { env } from "cloudflare:workers";
import { observeCore, renderText, type ScenarioVerdict } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import * as domain from "./domain.ts";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import sequential from "./sequential.sim.ts";
import handler, { type Env, fixed } from "./worker.ts";

/** Check with the core observed, as `eutaxy check` does for the scenario's specs. */
async function checkObserved(
  worker: ExportedHandler<Env>,
  spec = scenario,
): Promise<{ verdict: ScenarioVerdict; inputs: unknown[][] }> {
  const observer = observeCore(domain, ["decideRefund"]);
  try {
    const platform = createCloudflarePlatform({ env, handler: worker, schemas: { DB: schema } });
    const verdict = await check(spec, platform, { seed: "corpus" });
    return { verdict, inputs: observer.calls.map((c) => [...c.args]) };
  } finally {
    observer.restore();
  }
}

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const { verdict, inputs } = await checkObserved(handler);
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  expect(verdict.violation.keys).toEqual(["stale_read", '"o-1"']);
  expect(verdict.schedule.faults).toEqual([]);
  // Both requests decided on the same read: two decisions on a refunded total of 0, from two invocations.
  const decisions = verdict.trace.entries.filter((e) => e.target === "Core:decideRefund");
  expect(decisions.map((d) => (d.payload as { args: unknown[] }).args)).toEqual([
    [1000, 0, 600],
    [1000, 0, 400],
  ]);
  expect(new Set(decisions.map((d) => d.invocation)).size).toBe(2);
  expect(inputs).toContainEqual([1000, 0, 600]);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    specModules: [{ path: "./domain.ts", functions: ["decideRefund"] }],
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the compare-and-set fix holds", async () => {
  const { verdict } = await checkObserved(fixed);
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("one refund at a time, the shell follows the core, and the core sees what its off-by-one gets wrong", async () => {
  const { verdict, inputs } = await checkObserved(handler, sequential);
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
  expect(inputs).toContainEqual([1000, 600, 400]);
});

test("without the core observed, refines says no decision was recorded rather than passing", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus" });
  expect(verdict.kind).toBe("VIOLATED");
  if (verdict.kind === "VIOLATED") expect(verdict.violation.keys).toEqual(["no_decision"]);
});
