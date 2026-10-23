/** The differential runner without D1: the two sides must agree on every attempt. */
import type { ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { runDifferential } from "./differential.ts";
import type { QueueHandler, WorkerHandler } from "./platform.ts";
import { http, queue } from "./scenario.ts";

function spec(messages = 2): ScenarioSpec {
  return {
    version: 1,
    name: "diff",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: queue(
      "q",
      Array.from({ length: messages }, (_, i) => ({ body: { n: i } })),
    ),
    setup: [],
    externals: [],
    invariants: [
      {
        kind: "atLeastOnce",
        name: "x",
        effect: { target: "Queue:q", op: "ack" },
        key: "args.messageId",
        expected: [],
      },
    ],
    bounds: { maxFaultsPerRun: 0, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 1000 },
  };
}

type Handler = NonNullable<QueueHandler["queue"]>;

async function diff(handler: Handler) {
  return runDifferential(spec(), { env: {}, handler: { queue: handler }, schemas: {} });
}

describe("runDifferential", () => {
  test("agrees for a handler that acks", async () => {
    const r = await diff(async (batch) => batch.ackAll());
    expect(r.differences).toEqual([]);
    expect(r.equal).toBe(true);
    expect(r.eutaxy.attempts).toEqual([
      { event: "msg-1", attempt: 1, status: "completed", decision: "ack" },
      { event: "msg-2", attempt: 1, status: "completed", decision: "ack" },
    ]);
  });

  test("agrees for a handler that retries then is dead-lettered", async () => {
    const r = await diff(async (batch) => batch.retryAll());
    expect(r.equal).toBe(true);
    // Redeliveries queue behind the messages still waiting, on both sides.
    expect(r.raw.attempts.map((a) => `${a.event}#${a.attempt}`)).toEqual([
      "msg-1#1",
      "msg-2#1",
      "msg-1#2",
      "msg-2#2",
      "msg-1#3",
      "msg-2#3",
    ]);
    expect(r.raw.attempts.every((a) => a.decision === "retry")).toBe(true);
  });

  test("agrees for a handler that throws", async () => {
    const r = await diff(async () => {
      throw new Error("boom");
    });
    expect(r.equal).toBe(true);
    expect(r.eutaxy.attempts[0]).toEqual({
      event: "msg-1",
      attempt: 1,
      status: "errored",
      decision: null,
    });
  });

  test("an ignored acknowledgement after a retry does not count as the decision", async () => {
    const r = await diff(async (batch) => {
      batch.retryAll();
      batch.ackAll();
    });
    expect(r.equal).toBe(true);
    expect(r.eutaxy.attempts[0]?.decision).toBe("retry");
  });

  test("a run that touches an unproxied binding is never reported as agreement", async () => {
    const env = { KV: { get: async () => null } };
    const r = await runDifferential(spec(), {
      env,
      handler: {
        queue: async (batch, e) => {
          await (e as typeof env).KV.get();
          batch.ackAll();
        },
      },
      schemas: {},
    });
    expect(r.equal).toBe(false);
    expect(r.unsupported.join()).toContain("KV");
    expect(r.differences[0]).toContain("unsupported");
  });

  test("agrees for a handler that decides inside waitUntil work", async () => {
    const r = await diff(async (batch, _env, ctx) => {
      ctx.waitUntil(Promise.resolve().then(() => batch.messages[0]?.retry()));
    });
    expect(r.equal).toBe(true);
  });
});

describe("scripted externals on both sides", () => {
  const pay: ScenarioSpec = {
    ...spec(),
    externals: [
      {
        name: "pay",
        host: "api.pay.example",
        guarantees: { dedupeBy: "Idempotency-Key" },
        responses: [{ method: "POST", status: 201, body: { ok: true } }],
      },
    ],
  };

  test("both sides answer from the script and dedupe identically", async () => {
    const statuses: number[] = [];
    const r = await runDifferential(pay, {
      env: {},
      handler: {
        queue: async (batch) => {
          const a = await fetch("https://api.pay.example/charge", {
            method: "POST",
            headers: { "Idempotency-Key": "k" },
          });
          const b = await fetch("https://api.pay.example/charge", {
            method: "POST",
            headers: { "Idempotency-Key": "k" },
          });
          statuses.push(a.status, b.status);
          batch.ackAll();
        },
      },
      schemas: {},
    });
    expect(r.equal).toBe(true);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201, 201]);
  });

  test("time advances identically on both sides across a fetch", async () => {
    const seen: number[] = [];
    const r = await runDifferential(pay, {
      env: {},
      handler: {
        queue: async (batch) => {
          await fetch("https://api.pay.example/charge", { method: "POST" });
          seen.push(Date.now());
          batch.ackAll();
        },
      },
      schemas: {},
    });
    expect(r.equal).toBe(true);
    expect(seen).toHaveLength(4);
    expect(seen.slice(0, 2)).toEqual(seen.slice(2));
    expect(seen[0]).toBe(Date.UTC(2026, 0, 1) + 1);
  });

  test("an undeclared host is reported, never silently compared", async () => {
    const r = await runDifferential(pay, {
      env: {},
      handler: {
        queue: async (batch) => {
          await fetch("https://nowhere.example/").catch(() => undefined);
          batch.ackAll();
        },
      },
      schemas: {},
    }).catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
    expect(String(r)).toContain("undeclared host");
  });
});

describe("virtual globals on both sides", () => {
  test("both sides see the virtual epoch and the same randomness", async () => {
    const seen: [number, number][] = [];
    const r = await diff(async (batch) => {
      seen.push([Date.now(), Math.random()]);
      batch.ackAll();
    });
    expect(r.equal).toBe(true);
    expect(seen).toHaveLength(4); // two messages, two sides
    expect(seen[0]?.[0]).toBe(Date.UTC(2026, 0, 1));
    expect(seen[0]).toEqual(seen[2]);
    expect(seen[1]).toEqual(seen[3]);
  });

  test("a handler that uses the clock, randomness and a timer still agrees", async () => {
    const r = await diff(async (batch) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (Date.now() < 0 || Math.random() < 0) throw new Error("impossible");
      batch.ackAll();
    });
    expect(r.equal).toBe(true);
  });
});

describe("runDifferential with the http drive", () => {
  const httpSpec = (): ScenarioSpec => ({
    ...spec(),
    drive: http(
      [
        { path: "/hooks", body: { n: 1 } },
        { path: "/hooks", body: { n: 2 } },
      ],
      {
        retries: 1,
      },
    ),
  });
  const diffHttp = (fetch: NonNullable<WorkerHandler["fetch"]>) =>
    runDifferential(httpSpec(), { env: {}, handler: { fetch }, schemas: {} });

  test("agrees on statuses and on resends after a thrown error", async () => {
    // Deterministic by content, since both sides call the same handler in turn.
    const r = await diffHttp(async (request) => {
      const { n } = (await request.json()) as { n: number };
      if (n === 1) throw new Error("always fails");
      return Response.json({ ok: true });
    });
    expect(r.differences).toEqual([]);
    expect(r.eutaxy.attempts.map((a) => [a.event, a.attempt, a.status, a.response])).toEqual([
      ["req-1", 1, "errored", 500],
      ["req-2", 1, "completed", 200],
      ["req-1", 2, "errored", 500],
    ]);
    expect(r.raw.attempts).toEqual(r.eutaxy.attempts);
  });

  test("agrees when the handler answers 4xx and the caller gives up", async () => {
    const r = await diffHttp(async () => new Response("no", { status: 422 }));
    expect(r.differences).toEqual([]);
    expect(r.eutaxy.attempts.map((a) => a.response)).toEqual([422, 422, 422, 422]);
  });
});
