/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { renderText } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

const platformFor = (bindings: object) =>
  createCloudflarePlatform({ env: bindings, handler, schemas: {}, durableObjects: cloudflareTest });

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platformFor(env), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // The alarm fired, failed after the send, and its retry sent again.
  const alarms = verdict.trace.entries.filter((e) => e.kind === "call" && e.op === "alarm");
  expect(alarms.length).toBeGreaterThanOrEqual(2);
  const sends = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "Fetch:mail" && e.op === "POST",
  );
  expect(sends.length).toBeGreaterThanOrEqual(2);
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: {},
    durableObjects: true,
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the fixed object's idempotency key makes the retry harmless", async () => {
  const bindings = { REMINDERS: (env as unknown as { FIXED_REMINDERS: unknown }).FIXED_REMINDERS };
  const verdict = await check(scenario, platformFor(bindings), { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});
