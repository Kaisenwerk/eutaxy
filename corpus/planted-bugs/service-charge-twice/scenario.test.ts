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
  // One message suffices, and the trace has two completed charges for the same order.
  expect(verdict.keptEvents).toHaveLength(1);
  const charges = verdict.trace.entries.filter((e) => e.kind === "result" && e.op === "charge");
  expect(charges).toHaveLength(2);
  expect(verdict.assumptions.join("\n")).toContain("scripted callees");
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql" },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("a lost answer after the callee charged makes the redelivery charge again", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  const spec = restrictSpec(platform, scenario, ["msg-1"]);
  // Effects of msg-1#1 in order: 0 the charge, 1 the insert, 2 the implicit ack.
  const log = await replay(spec, platform, {
    seed: 0,
    faults: [
      {
        invocation: "msg-1#1",
        ordinal: 0,
        fault: "ambiguous",
        target: "Service:BILLING",
        op: "charge",
      },
    ],
  });
  const ops = log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.op}`);
  expect(ops.slice(0, 3)).toEqual([
    "msg-1#1 call charge",
    "msg-1#1 result charge",
    "msg-1#1 fault charge",
  ]);
  expect(ops.filter((o) => o.endsWith("result charge"))).toEqual([
    "msg-1#1 result charge",
    "msg-1#2 result charge",
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["charged-once"]);
});
