/** Runs inside workerd: the proxied and raw runs agree on every tick and on the final tables. */

import { env } from "cloudflare:workers";
import { check, createCloudflarePlatform, expectHolds, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test("proxied and raw runs agree on every tick's outcome and on the rollups", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: { DB: schema } });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.eutaxy.attempts.map((a) => [a.event, a.attempt, a.status, a.decision])).toEqual([
    ["tick-1", 1, "completed", null],
    ["tick-2", 1, "completed", null],
    ["tick-3", 1, "completed", null],
  ]);
  // The engine's virtual epoch, where the clock starts.
  const virtualEpoch = Date.UTC(2026, 0, 1);
  const m = 60_000;
  expect(result.eutaxy.state["DB"]?.["rollups"]).toEqual([
    { tick: virtualEpoch, cron: "*/10 * * * *", n: 2 },
    { tick: virtualEpoch + 10 * m, cron: "*/10 * * * *", n: 3 },
    { tick: virtualEpoch + 20 * m, cron: "*/10 * * * *", n: 4 },
  ]);
});

test("one rollup per tick, with faults at the reads and writes", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40, budgetMs: 30_000 });
  const verdict = await check(scenario, platform, {
    seed: "faults",
    maxRuns: 40,
    budgetMs: 30_000,
  });
  expect(verdict.kind).toBe("BOUNDED");
});
