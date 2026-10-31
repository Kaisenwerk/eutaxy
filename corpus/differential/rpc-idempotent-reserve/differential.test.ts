/** Runs inside workerd: the proxied and raw runs agree on every call's answer and on the final table. */

import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform, expectHolds, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test("proxied and raw runs agree on every attempt's answer", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: { DB: schema } });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  // The rejected call is resent twice and the caller gives up; the reads answer with data or null.
  expect(result.eutaxy.attempts.map((a) => [a.event, a.attempt, a.result])).toEqual([
    ["call-1", 1, { ok: true, value: { orderId: "o-1", reserved: true } }],
    ["call-2", 1, { ok: true, value: { orderId: "o-2", reserved: true } }],
    ["call-3", 1, { ok: false, error: "RangeError: qty must be positive, got 0" }],
    ["call-4", 1, { ok: true, value: { orderId: "o-1", qty: 2 } }],
    ["call-5", 1, { ok: true, value: null }],
    ["call-3", 2, { ok: false, error: "RangeError: qty must be positive, got 0" }],
    ["call-3", 3, { ok: false, error: "RangeError: qty must be positive, got 0" }],
  ]);
  expect(result.eutaxy.state["DB"]?.["reservations"]).toEqual([
    { order_id: "o-1", qty: 2 },
    { order_id: "o-2", qty: 1 },
  ]);
});

test("reserved once and every order reserved, with faults at the insert and the answer", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40, budgetMs: 30_000 });
  const verdict = await check(scenario, platform, {
    seed: "faults",
    maxRuns: 40,
    budgetMs: 30_000,
  });
  expect(verdict.kind).toBe("BOUNDED");
  expect(verdict.assumptions.join("\n")).toContain("inbound RPC");
});
