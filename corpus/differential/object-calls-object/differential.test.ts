/** Runs inside workerd: the proxied and raw runs agree on every answer and on what each object holds after calls between them. */

import * as cloudflareTest from "cloudflare:test";
import { env } from "cloudflare:workers";
import { replay } from "eutaxy";
import { check, createCloudflarePlatform, runDifferential } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import * as worker from "./worker.ts";

const options = {
  env,
  handler: worker.default,
  schemas: {},
  exports: worker,
  durableObjects: cloudflareTest,
};

test("proxied and raw runs agree on every answer and on each object's tables", async () => {
  const result = await runDifferential(scenario, options);
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.equal).toBe(true);
  expect(result.eutaxy.attempts.map((a) => [a.event, a.attempt, a.status, a.response])).toEqual([
    ["add-1", 1, "completed", 201],
    ["add-2", 1, "completed", 409],
    ["add-3", 1, "completed", 201],
    ["who-1", 1, "completed", 200],
  ]);
  expect(result.eutaxy.state["CART"]?.["c1/items"]).toEqual([{ item: "widget", holder: "c1" }]);
  expect(result.eutaxy.state["CART"]?.["c2/items"]).toEqual([]);
  expect(result.eutaxy.state["SHELF"]?.["widget/takes"]).toEqual([
    { cart: "c1", unit: 1, audited: 1 },
  ]);
  expect(result.eutaxy.state["AUDIT"]?.["log/seen"]).toEqual([{ cart: "c1", item: "widget" }]);
});

test("under the proxies every call between the objects is recorded, and nothing is unsupported", async () => {
  const platform = createCloudflarePlatform(options);
  const log = await replay(scenario, platform, { seed: 0, faults: [] });
  const calls = log.entries
    .filter((e) => e.kind === "call" && e.target.startsWith("DO:"))
    .map((e) => `${e.invocation} ${e.target} ${e.op}`);
  expect(calls).toEqual([
    "add-1#1 DO:CART add",
    "add-1#1 DO:SHELF take",
    // The shelf asks the cart that is waiting on it, then tells the auditor, which calls back.
    "add-1#1 DO:CART limit",
    "add-1#1 DO:AUDIT note",
    "add-1#1 DO:SHELF audited",
    "add-2#1 DO:CART add",
    "add-2#1 DO:SHELF take",
    "add-2#1 DO:CART limit",
    // The first cart holds its unit already: the shelf asks nobody.
    "add-3#1 DO:CART add",
    "add-3#1 DO:SHELF take",
    "who-1#1 DO:CART holders",
    "who-1#1 DO:SHELF holders",
  ]);
  const verdict = await check(scenario, platform, { seed: "differential", budgetMs: 30_000 });
  expect(verdict.kind).toBe("BOUNDED");
});
