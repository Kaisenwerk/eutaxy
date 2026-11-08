/** Runs inside workerd: the proxied and raw runs agree on every answer and on the object's tables after its work. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createCloudflarePlatform, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import handler from "./worker.ts";

test("proxied and raw runs agree on every answer and on the object's tables", async () => {
  const result = await runDifferential(scenario, {
    env,
    handler,
    schemas: {},
    durableObjects: cloudflareTest,
  });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.eutaxy.attempts.map((a) => [a.event, a.attempt, a.status, a.response])).toEqual([
    ["run-1", 1, "completed", 200],
    ["run-2", 1, "completed", 200],
  ]);
  expect(result.eutaxy.state["RUNNER"]?.["r/totals"]).toEqual([{ id: "all", steps: 4 }]);
});

test("the platform under the proxies lets the object finish its work: nothing unsupported", async () => {
  const platform = createCloudflarePlatform({
    env,
    handler,
    schemas: {},
    durableObjects: cloudflareTest,
  });
  const { check } = await import("eutaxy/cloudflare");
  const verdict = await check(scenario, platform, { seed: "differential", budgetMs: 30_000 });
  expect(verdict.kind).toBe("BOUNDED");
});
