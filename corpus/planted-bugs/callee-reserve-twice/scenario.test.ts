/** Runs inside workerd under the Cloudflare Vitest plugin, with the bindings from wrangler.jsonc: the inventory Worker's under its qualified name. */

import { env } from "cloudflare:workers";
import { lastSnapshot } from "@eutaxy/core";
import { checkInvariants, renderText, replay, restrictSpec } from "eutaxy";
import { check, cloudflareRegressionTest, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import inventorySchema from "./inventory/schema.sql?raw";
import * as inventory from "./inventory/worker.ts";
import manifest from "./manifest.json";
import committedRegression from "./regression.test.ts?raw";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import scripted from "./scripted.sim.ts";
import handler from "./worker.ts";

const platform = () =>
  createCloudflarePlatform({
    env,
    handler,
    schemas: { DB: schema, "inventory/DB": inventorySchema },
    callees: { INVENTORY: { name: "inventory", exports: inventory } },
  });

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const verdict = await check(scenario, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  // One message suffices: the trace has two reserve calls answered, each hosting the inventory
  // Worker's invocation, whose writes went to its own database.
  expect(verdict.keptEvents).toHaveLength(1);
  const entries = verdict.trace.entries;
  const reserves = entries.filter(
    (e) => e.kind === "result" && e.target === "Service:INVENTORY" && e.op === "reserve",
  );
  expect(reserves).toHaveLength(2);
  const hosted = entries.filter((e) => /\/INVENTORY\.reserve/.test(e.invocation));
  expect(hosted.length).toBeGreaterThan(0);
  expect(new Set(hosted.map((e) => e.target))).toEqual(new Set(["D1:inventory/DB"]));
  const rows = lastSnapshot(verdict.trace as never, "D1:inventory/DB")?.["reservations"] as {
    order_id: string;
  }[];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.order_id).toBe(rows[1]?.order_id);
  expect(verdict.assumptions.join("\n")).toContain("callee() setup runs that Worker's real code");
  const emitted = cloudflareRegressionTest(verdict, {
    scenarioPath: "./scenario.sim.ts",
    workerPath: "./worker.ts",
    schemaPaths: { DB: "./schema.sql", "inventory/DB": "./inventory/schema.sql" },
    callees: { INVENTORY: { name: "inventory", path: "./inventory/worker.ts" } },
    expect: "violates",
  });
  expect(emitted).toBe(committedRegression);
});

test("the same scenario with the inventory Worker scripted misses the bug: BOUNDED", async () => {
  const verdict = await check(scripted, platform(), { seed: "corpus", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("a lost answer after the inventory Worker reserved makes the redelivery reserve again under a new key", async () => {
  const p = platform();
  const spec = restrictSpec(p, scenario, ["msg-1"]);
  // Effects of msg-1#1 in order: 0 the reserve call (hosting the inventory Worker's read and insert), 1 the order insert, 2 the implicit ack.
  const log = await replay(spec, p, {
    seed: 0,
    faults: [
      {
        invocation: "msg-1#1",
        ordinal: 0,
        fault: "ambiguous",
        target: "Service:INVENTORY",
        op: "reserve",
      },
    ],
  });
  const ops = log.entries
    .filter((e) => e.kind !== "snapshot")
    .map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
  expect(ops.slice(0, 7)).toEqual([
    "msg-1#1 call Service:INVENTORY reserve",
    "msg-1#1/INVENTORY.reserve call D1:inventory/DB first",
    "msg-1#1/INVENTORY.reserve result D1:inventory/DB first",
    "msg-1#1/INVENTORY.reserve call D1:inventory/DB run",
    "msg-1#1/INVENTORY.reserve result D1:inventory/DB run",
    "msg-1#1 result Service:INVENTORY reserve",
    "msg-1#1 fault Service:INVENTORY reserve",
  ]);
  expect(ops.filter((o) => o.endsWith("result D1:inventory/DB run"))).toEqual([
    "msg-1#1/INVENTORY.reserve result D1:inventory/DB run",
    "msg-1#2/INVENTORY.reserve result D1:inventory/DB run",
  ]);
  const violations = checkInvariants(log, spec.invariants);
  expect(violations.map((v) => v.invariant)).toEqual(["one-reservation-per-order"]);
});
