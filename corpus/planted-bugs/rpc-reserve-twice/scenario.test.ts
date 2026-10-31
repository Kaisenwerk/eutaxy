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
  // One call suffices, and the trace has two committed inserts for the same order id.
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

test("a crash before the answer makes the caller resend, and the resend inserts again", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["call-1"]);
  // Effects of call-1#1 in order: 0 the insert, 1 the response.
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      {
        invocation: "call-1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Rpc:reserve",
        op: "response",
      },
    ],
  });
  const ops = log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.op}`);
  expect(ops).toEqual([
    "call-1#1 call run",
    "call-1#1 result run",
    "call-1#1 call response",
    "call-1#1 fault response",
    "call-1#2 call run",
    "call-1#2 result run",
    "call-1#2 call response",
    "call-1#2 result response",
  ]);
  const answer = log.entries.find((e) => e.kind === "result" && e.op === "response");
  expect(answer?.payload).toEqual({
    args: { callId: "call-1", method: "reserve", args: ["o-1", 2] },
    result: { ok: true, value: { orderId: "o-1", qty: 2 } },
  });
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["reserved-once"]);
});
