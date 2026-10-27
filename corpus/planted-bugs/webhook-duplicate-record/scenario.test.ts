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
  // One request suffices, and the trace has two committed inserts for the same event id.
  expect(verdict.keptEvents).toHaveLength(1);
  const inserts = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "run");
  expect(inserts).toHaveLength(2);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a crash before the response makes the provider resend, and the resend inserts again", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["req-1"]);
  // Effects of req-1#1 in order: 0 the insert, 1 the response.
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      {
        invocation: "req-1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Http:/webhooks/payments",
        op: "response",
      },
    ],
  });
  const ops = log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.op}`);
  expect(ops).toEqual([
    "req-1#1 call run",
    "req-1#1 result run",
    "req-1#1 call response",
    "req-1#1 fault response",
    "req-1#2 call run",
    "req-1#2 result run",
    "req-1#2 call response",
    "req-1#2 result response",
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["event-recorded-once"]);
});
