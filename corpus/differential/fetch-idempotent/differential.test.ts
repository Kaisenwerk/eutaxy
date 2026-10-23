/** Runs inside workerd: the proxied and raw runs agree, and the idempotency key makes the charge safe under faults. */

import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform, expectHolds, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

test("proxied and raw runs agree on every attempt", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: {} });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.eutaxy.attempts).toHaveLength(2);
});

test("charged once and every order charged, with faults at the fetch and the ack", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: {} });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40 });
  const verdict = await check(scenario, platform, { seed: "faults", maxRuns: 40 });
  expect(verdict.kind).toBe("BOUNDED");
  expect(verdict.assumptions.join("\n")).toContain("dedupeBy");
});
