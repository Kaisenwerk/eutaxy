/**
 * Service bindings with the callee scripted: each call is one effect with a
 * Durable Object stub call's faults, answered from the scenario's `service`
 * setup, and the real binding is never called.
 */
import type { EffectLog, ScenarioSpec, Schedule } from "@eutaxy/core";
import { Run, replayChooser, runOnce } from "@eutaxy/engine";
import { describe, expect, test } from "vitest";
import { createCloudflarePlatform, type WorkerHandler } from "./platform.ts";
import { queue, service, serviceCall } from "./scenario.ts";
import { isServiceBinding, scriptedError } from "./services.ts";

/** A test double for the runtime's Fetcher: fetch and connect, and a record of being called. */
class FakeFetcher {
  calls = 0;
  async fetch(_input?: unknown, _init?: unknown): Promise<Response> {
    this.calls++;
    return new Response("real");
  }
  connect(): never {
    this.calls++;
    throw new Error("real connect");
  }
}

const bounds = {
  maxFaultsPerRun: 1,
  maxRedeliveries: 1,
  maxConcurrentInvocations: 1,
  budgetMs: 10_000,
};

function spec(setup: ScenarioSpec["setup"]): ScenarioSpec {
  return {
    version: 1,
    name: "services",
    worker: { entry: "./w.ts", config: "./wrangler.jsonc" },
    drive: queue("q", [{ body: { orderId: "o-1" } }]),
    setup,
    externals: [],
    invariants: [],
    bounds,
  };
}

type Env = { BILLING: FakeFetcher };

async function run(
  s: ScenarioSpec,
  handler: (env: Env) => Promise<unknown>,
  faults: Schedule["faults"] = [],
): Promise<{ log: EffectLog; run: Run; real: FakeFetcher; seen: unknown[] }> {
  const real = new FakeFetcher();
  const seen: unknown[] = [];
  const queueHandler: WorkerHandler = {
    async queue(_batch, env) {
      seen.push(await handler(env as Env));
    },
  };
  const platform = createCloudflarePlatform({
    env: { BILLING: real },
    handler: queueHandler,
    schemas: {},
  });
  const r = new Run({ chooser: replayChooser({ seed: 1, faults }), bounds });
  const log = await runOnce(s, platform, r);
  return { log, run: r, real, seen };
}

const effects = (log: EffectLog, target = "Service:BILLING") =>
  log.entries.filter((e) => e.target === target).map((e) => `${e.kind} ${e.op}`);
const results = (log: EffectLog) =>
  log.entries
    .filter((e) => e.kind === "result" && e.target === "Service:BILLING")
    .map((e) => e.payload);

describe("recognising a service binding", () => {
  test("a Fetcher-shaped value is one; the other kinds are not, even with fetch and connect", () => {
    expect(isServiceBinding(new FakeFetcher())).toBe(true);
    expect(isServiceBinding({ fetch() {}, connect() {}, prepare() {} })).toBe(false);
    expect(isServiceBinding({ fetch() {}, connect() {}, idFromName() {} })).toBe(false);
    expect(isServiceBinding({ fetch() {} })).toBe(false);
    expect(isServiceBinding(null)).toBe(false);
  });

  test("the runtime's Fetcher class is recognised by instance, whatever its shape", () => {
    class Fetcher {}
    const g = globalThis as { Fetcher?: unknown };
    g.Fetcher = Fetcher;
    try {
      expect(isServiceBinding(new Fetcher())).toBe(true);
    } finally {
      delete g.Fetcher;
    }
  });
});

describe("RPC through the binding", () => {
  const billing = service("BILLING", {
    methods: {
      charge: { returns: { chargeId: "ch-1" } },
      refund: { throws: "RangeError: already refunded" },
    },
  });

  test("a method call is one effect, answered from the script; the real binding is never called", async () => {
    const { log, real, seen } = await run(spec([billing]), (env) =>
      (env.BILLING as unknown as { charge(id: string, n: number): Promise<unknown> }).charge(
        "o-1",
        500,
      ),
    );
    expect(effects(log)).toEqual(["call charge", "result charge"]);
    expect(results(log)).toEqual([
      { args: { args: ["o-1", 500] }, result: { value: { chargeId: "ch-1" } } },
    ]);
    expect(seen).toEqual([{ chargeId: "ch-1" }]);
    expect(real.calls).toBe(0);
  });

  test("a scripted error is thrown to the caller with its name and message, and recorded", async () => {
    const { log, seen } = await run(spec([billing]), (env) =>
      (env.BILLING as unknown as { refund(): Promise<unknown> })
        .refund()
        .catch((e: Error) => `${e.name}: ${e.message}`),
    );
    expect(seen).toEqual(["RangeError: already refunded"]);
    expect(results(log)[0]).toMatchObject({ result: null, error: "RangeError: already refunded" });
  });

  test("the reply is a copy: the Worker cannot change the script", async () => {
    const { seen } = await run(spec([billing]), async (env) => {
      const b = env.BILLING as unknown as { charge(): Promise<{ chargeId: string }> };
      const first = await b.charge();
      first.chargeId = "changed";
      return (await b.charge()).chargeId;
    });
    expect(seen).toEqual(["ch-1"]);
  });

  test("an awaited property is a call too, recorded as a property read", async () => {
    const { log } = await run(spec([billing]), (env) =>
      Promise.resolve((env.BILLING as unknown as { charge: Promise<unknown> }).charge),
    );
    expect(results(log)).toEqual([
      { args: { property: true }, result: { value: { chargeId: "ch-1" } } },
    ]);
  });

  test("with no methods scripted every method returns null; a missing method makes the run unsupported", async () => {
    const any = await run(spec([service("BILLING")]), (env) =>
      (env.BILLING as unknown as { whatever(): Promise<unknown> }).whatever(),
    );
    expect(any.seen).toEqual([null]);
    expect(any.run.unsupportedReasons).toEqual([]);
    const missing = await run(spec([billing]), (env) =>
      (env.BILLING as unknown as { other(): Promise<unknown> }).other().catch(() => "failed"),
    );
    expect(missing.run.unsupportedReasons.join()).toContain("no scripted reply for method other");
  });

  test("the faults are a stub call's: ambiguous means the callee acted and the answer was lost", async () => {
    const faults: Schedule["faults"] = [
      {
        invocation: "msg-1#1",
        ordinal: 0,
        fault: "ambiguous",
        target: "Service:BILLING",
        op: "charge",
      },
    ];
    const { log, seen } = await run(
      spec([billing]),
      (env) =>
        (env.BILLING as unknown as { charge(): Promise<unknown> }).charge().catch(() => "lost"),
      faults,
    );
    expect(effects(log)).toEqual(["call charge", "result charge", "fault charge"]);
    expect(seen).toEqual(["lost"]);
    expect(log.entries.find((e) => e.kind === "call")?.payload).toEqual({ args: { args: [] } });
  });

  test("pipelining on a call's promise and connect() make the run unsupported", async () => {
    const { run: r } = await run(spec([billing]), async (env) => {
      const b = env.BILLING as unknown as { charge(): { later: unknown }; connect(): unknown };
      void b.charge().later;
      try {
        b.connect();
      } catch {
        // reported
      }
      return null;
    });
    expect(r.unsupportedReasons.join("\n")).toMatch(/pipelining[\s\S]*connect\(\)/);
  });

  test("a binding without a service() setup is reported, and never the real one", async () => {
    const { run: r, real } = await run(spec([]), (env) =>
      (env.BILLING as unknown as { charge(): Promise<unknown> }).charge().catch(() => "failed"),
    );
    expect(r.unsupportedReasons[0]).toContain("needs a service() setup step");
    expect(real.calls).toBe(0);
  });
});

describe("fetch() through the binding", () => {
  test("each request is one effect under the HTTP method, answered by method and path like an external", async () => {
    const billing = service("BILLING", {
      fetch: [
        { method: "POST", path: "/charges", status: 201, body: { id: "ch-9" } },
        { path: "/health", status: 204 },
      ],
    });
    const { log, seen } = await run(spec([billing]), async (env) => {
      const r = await env.BILLING.fetch(
        new Request("https://billing.internal/charges", {
          method: "POST",
          body: JSON.stringify({ orderId: "o-1" }),
          headers: { "content-type": "application/json" },
        }),
      );
      const h = await env.BILLING.fetch("https://any.host/health");
      return [r.status, await r.json(), h.status];
    });
    expect(seen).toEqual([[201, { id: "ch-9" }, 204]]);
    expect(effects(log)).toEqual(["call POST", "result POST", "call GET", "result GET"]);
    expect(results(log)[0]).toEqual({
      args: {
        url: "https://billing.internal/charges",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { orderId: "o-1" },
      },
      result: { status: 201 },
    });
  });

  test("a redirect reply is followed by the runtime, so it is unsupported unless the fetch is manual", async () => {
    const redirecting = service("BILLING", {
      fetch: [{ path: "/start", status: 302, headers: { location: "/end" } }],
    });
    const followed = await run(spec([redirecting]), (env) =>
      env.BILLING.fetch("https://x/start").catch(() => "failed"),
    );
    expect(followed.run.unsupportedReasons.join()).toContain(
      "302 redirect, which the runtime would follow",
    );
    const manual = await run(
      spec([redirecting]),
      async (env) => (await env.BILLING.fetch("https://x/start", { redirect: "manual" })).status,
    );
    expect(manual.seen).toEqual([302]);
    expect(manual.run.unsupportedReasons).toEqual([]);
  });

  test("with no replies scripted every request gets 200; an unmatched request makes the run unsupported", async () => {
    const open = await run(
      spec([service("BILLING")]),
      async (env) => (await env.BILLING.fetch("https://x/anything")).status,
    );
    expect(open.seen).toEqual([200]);
    const scripted = await run(
      spec([service("BILLING", { fetch: [{ path: "/a", status: 200 }] })]),
      (env) => env.BILLING.fetch("https://x/b").catch(() => "failed"),
    );
    expect(scripted.run.unsupportedReasons.join()).toContain("no scripted reply for fetch GET /b");
  });
});

describe("the scenario side", () => {
  test("serviceCall selects completed calls, of one method or all", () => {
    expect(serviceCall("BILLING", "charge")).toEqual({
      target: "Service:BILLING",
      op: "charge",
      kind: "result",
    });
    expect(serviceCall("BILLING")).toEqual({ target: "Service:BILLING", kind: "result" });
  });

  test("a scripted error is the built-in class it names, as RPC keeps the type; other names ride on an Error", () => {
    const e = scriptedError("RangeError: too much");
    expect(e).toBeInstanceOf(RangeError);
    expect([e.name, e.message]).toEqual(["RangeError", "too much"]);
    const custom = scriptedError("PaymentDeclined: card expired");
    expect(custom).toBeInstanceOf(Error);
    expect([custom.name, custom.message]).toEqual(["PaymentDeclined", "card expired"]);
    const plain = scriptedError("boom");
    expect([plain.name, plain.message]).toEqual(["Error", "boom"]);
  });
});
