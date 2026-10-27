/** Runs inside workerd: the proxied run and the raw run must agree on attempts and final state. */

import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform, expectHolds, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test("proxies agree with the raw bindings", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: { DB: schema } });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.equal).toBe(true);
  expect(result.eutaxy.attempts).toHaveLength(3);
  expect(result.eutaxy.state["DB"]?.["postings"]).toHaveLength(3);
});

test("the end-of-run snapshot feeds state invariants", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  // Fault-free: the ledger is correct by construction, so both state invariants hold.
  const verdict = await check(scenario, platform, {
    seed: "fault-free",
    maxRuns: 1,
    faultProbability: 0,
    budgetMs: 30_000,
  });
  expect(verdict.kind).toBe("BOUNDED");
  const snapshot = verdict.kind === "BOUNDED" ? null : verdict;
  expect(snapshot).toBeNull();
});

test("balances stay non-negative and every ack has its posting under faults too", async () => {
  // The ledger is idempotent on posting_id, so crashes and redeliveries cannot break either invariant.
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40 });
});
