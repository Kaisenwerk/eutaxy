/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import { env } from "cloudflare:workers";
import { checkInvariants, renderText, replay, restrictSpec } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const verdict = await check(scenario, platform, { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // The one tick, re-run once: the trace has two posts for the same dispatch id among them.
  expect(verdict.keptEvents).toEqual(["tick-1"]);
  const posts = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "POST");
  expect(posts.length).toBeGreaterThanOrEqual(2);
  expect(verdict.assumptions.join("\n")).toContain("cron triggers");
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a crash after the first post makes the re-run post it again, at the same scheduledTime", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["tick-1"]);
  // Effects of tick-1#1 in order: 0 the SELECT, 1 the first POST, 2 its UPDATE, ...
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      {
        invocation: "tick-1#1",
        ordinal: 1,
        fault: "crash_after",
        target: "Fetch:dispatcher",
        op: "POST",
      },
    ],
  });
  const posts = log.entries
    .filter((e) => e.kind === "result" && e.op === "POST")
    .map((e) => [
      e.invocation,
      (e.payload as { args: { body: { dispatchId: string } } }).args.body.dispatchId,
    ]);
  expect(posts).toEqual([
    ["tick-1#1", "d-1"],
    ["tick-1#2", "d-1"],
    ["tick-1#2", "d-2"],
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["dispatched-once"]);
});
