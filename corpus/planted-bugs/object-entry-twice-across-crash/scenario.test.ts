/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario, { deposits } from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import * as worker from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler: worker.default,
    schemas: { LEDGER: schema },
    exports: worker,
    durableObjects: cloudflareTest,
  });
const fixed = deposits("SAFE_ACCOUNT");

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One fault, on the object's own statement, made inside the call it is serving.
  expect(verdict.schedule.faults).toHaveLength(1);
  expect(verdict.schedule.faults[0]).toMatchObject({ target: "D1:LEDGER", op: "run" });
  expect(verdict.schedule.faults[0]?.invocation).toMatch(/^dep-\d#1$/);
  // Both entries are the object's: one in the call, one in the caller's resend of it.
  const entries = verdict.trace.entries
    .filter((e) => e.kind === "call" && e.target === "D1:LEDGER")
    .map((e) => e.invocation);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatch(/#1$/);
  expect(entries[1]).toMatch(/#2$/);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { LEDGER: "./schema.sql" },
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed object writes an entry that can be written twice, and no deposit is entered twice", async () => {
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
