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
  // Whatever crash the seed finds first, it lands after the acknowledgement and before the insert.
  const ops = verdict.trace.entries.map((e) => `${e.kind}:${e.target}:${e.op}`);
  expect(ops.indexOf("result:Queue:payments:ack")).toBeLessThan(
    ops.findIndex((k) => k.startsWith("fault:")),
  );
  expect(ops.filter((k) => k === "call:D1:DB:run")).toHaveLength(0);
  expect(verdict.keptEvents).toHaveLength(1);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a cut_off at the background point loses the write after the lookup completes", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["msg-1"]);
  // Effects of msg-1#1 in order: 0 ack, 1 the lookup (started before the handler returned), 2 background.
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      {
        invocation: "msg-1#1",
        ordinal: 2,
        fault: "cut_off",
        target: "Queue:payments",
        op: "background",
      },
    ],
  });
  const ops = log.entries.filter((e) => e.kind !== "snapshot").map((e) => `${e.kind} ${e.op}`);
  expect(ops).toEqual([
    "call ack",
    "result ack",
    "call first",
    "call background",
    "fault background",
    "result first",
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["every-payment-recorded"]);
});
