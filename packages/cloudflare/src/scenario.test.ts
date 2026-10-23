import { describe, expect, test } from "vitest";
import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  external,
  fetchCall,
  queue,
} from "./scenario.ts";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { id: "second", body: { orderId: "o-2", amountCents: 500 } },
]);

describe("queue", () => {
  test("assigns positional ids unless given", () => {
    expect(payments.messages.map((m) => m.id)).toEqual(["msg-1", "second"]);
  });
});

describe("d1Write and d1Param", () => {
  test("select committed D1 results and name bound parameters", () => {
    expect(d1Write("DB")).toEqual({
      target: "D1:DB",
      op: "run",
      kind: "result",
      atLeast: { "result.changes": 1 },
    });
    expect(d1Param(0)).toBe("args.params.0");
  });
});

describe("atLeastOncePerMessage", () => {
  test("derives the expected keys from the drive", () => {
    const inv = atLeastOncePerMessage("all", payments, d1Write("DB"), d1Param(0), "orderId");
    expect(inv.expected).toEqual(["o-1", "o-2"]);
    expect(inv.perMessage).toEqual({ bodyKey: "orderId" });
  });

  test("refuses a message without the body key", () => {
    const drive = queue("q", [{ body: { nope: 1 } }]);
    expect(() => atLeastOncePerMessage("all", drive, d1Write("DB"), d1Param(0), "orderId")).toThrow(
      /msg-1 has no "orderId"/,
    );
  });
});

describe("external and fetchCall", () => {
  test("build a declaration and a selector on effective requests", () => {
    expect(external("pay", "api.pay.example")).toEqual({
      name: "pay",
      host: "api.pay.example",
      guarantees: {},
    });
    expect(
      external("pay", "api.pay.example", {
        dedupeBy: "Idempotency-Key",
        responses: [{ status: 201 }],
      }),
    ).toEqual({
      name: "pay",
      host: "api.pay.example",
      guarantees: { dedupeBy: "Idempotency-Key" },
      responses: [{ status: 201 }],
    });
    expect(fetchCall("pay", "post")).toEqual({
      target: "Fetch:pay",
      op: "POST",
      kind: "result",
      where: { "result.effective": true },
    });
    expect(fetchCall("pay")).toEqual({
      target: "Fetch:pay",
      kind: "result",
      where: { "result.effective": true },
    });
  });
});

describe("defineScenario", () => {
  test("fills defaults and validates", () => {
    const spec = defineScenario({
      name: "queue-duplicate-write",
      worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
      drive: payments,
      setup: [d1Schema("DB", "./schema.sql")],
      invariants: [atMostOncePerKey("once", d1Write("DB"), d1Param(0))],
      bounds: { maxRedeliveries: 3 },
    });
    expect(spec.version).toBe(1);
    expect(spec.externals).toEqual([]);
    expect(spec.bounds).toEqual({
      maxFaultsPerRun: 1,
      maxRedeliveries: 3,
      maxConcurrentInvocations: 1,
      budgetMs: 2000,
    });
    expect(spec.drive).toEqual(payments);
  });

  test("accepts a raw drive and assigns ids", () => {
    const spec = defineScenario({
      name: "raw",
      worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
      drive: { kind: "queue", queue: "q", messages: [{ body: 1 }] },
      invariants: [atMostOncePerKey("once", d1Write("DB"), d1Param(0))],
    });
    expect(spec.drive).toEqual({ kind: "queue", queue: "q", messages: [{ id: "msg-1", body: 1 }] });
  });

  test("throws listing every validation error", () => {
    expect(() =>
      defineScenario({
        name: "Bad",
        worker: { entry: "", config: "./wrangler.jsonc" },
        drive: payments,
        invariants: [],
      }),
    ).toThrow(/name must be lowercase[\s\S]*worker\.entry[\s\S]*at least one invariant/);
  });
});
