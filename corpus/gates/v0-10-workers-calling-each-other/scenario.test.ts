/** Runs inside workerd: the v0.10 gate Worker's scenarios hold with no UNSUPPORTED verdict. */

import { env } from "cloudflare:workers";
import { checkInvariants, renderText, replay } from "eutaxy";
import { check, createCloudflarePlatform } from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import ordersOverRpc from "./orders-rpc.sim.ts";
import reconcileByCron from "./reconcile-cron.sim.ts";
import reconcileSchema from "./schema.reconcile.sql?raw";
import schema from "./schema.sql?raw";
import * as worker from "./worker.ts";

const platform = (db: string) =>
  createCloudflarePlatform({ env, handler: worker.default, schemas: { DB: db }, exports: worker });

test("driven over RPC, calling the partner over a service binding and the fulfilment Workflow: BOUNDED", async () => {
  const verdict = await check(ordersOverRpc, platform(schema), { seed: "gate", budgetMs: 30_000 });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("driven by cron, reconciling shipments through the partner into the Workflows' waits: BOUNDED", async () => {
  const verdict = await check(reconcileByCron, platform(reconcileSchema), {
    seed: "gate",
    budgetMs: 30_000,
  });
  expect(verdict.kind, renderText(verdict)).toBe("BOUNDED");
});

test("a confirmation whose answer was lost is resent after the fulfilment completed, and acknowledged", async () => {
  // Effects of call-3#1 (confirmShipment o-1): the status read, create, get, send_event, then the response.
  const log = await replay(ordersOverRpc, platform(schema), {
    seed: 0,
    faults: [
      {
        invocation: "call-3#1",
        ordinal: 4,
        fault: "crash_before",
        target: "Rpc:Orders.confirmShipment",
        op: "response",
      },
    ],
  });
  expect(log.entries.some((e) => e.kind === "fault" && e.op === "response")).toBe(true);
  const answers = log.entries.filter(
    (e) => e.kind === "result" && e.op === "response" && e.target === "Rpc:Orders.confirmShipment",
  );
  expect(answers.map((e) => e.invocation)).toContain("call-3#2");
  expect(checkInvariants(log, ordersOverRpc.invariants)).toEqual([]);
});

test("a fault-free run crosses all four boundaries", async () => {
  const rpcLog = await replay(ordersOverRpc, platform(schema), { seed: 0, faults: [] });
  const targets = (log: { entries: readonly { target: string; op: string; kind: string }[] }) =>
    new Set(log.entries.filter((e) => e.kind === "result").map((e) => `${e.target} ${e.op}`));
  const seen = targets(rpcLog);
  expect(seen).toContain("Rpc:Orders.placeOrder response");
  expect(seen).toContain("Service:PARTNER quote");
  expect(seen).toContain("Workflow:FULFILMENT send_event");
  expect(seen).toContain("Workflow:FULFILMENT event");
  expect(seen).toContain("Workflow:FULFILMENT complete");
  const cronLog = await replay(reconcileByCron, platform(reconcileSchema), { seed: 0, faults: [] });
  const cronSeen = targets(cronLog);
  expect(cronSeen).toContain("Service:PARTNER shipment");
  expect(cronSeen).toContain("Workflow:FULFILMENT send_event");
  expect(cronSeen).toContain("Workflow:FULFILMENT complete");
  expect([...cronSeen].some((t) => t.startsWith("Cron:") || t.startsWith("D1:DB"))).toBe(true);
});
