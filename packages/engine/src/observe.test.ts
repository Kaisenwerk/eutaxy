/** Observing a core module: calls during runs are recorded and logged as decisions, for `refines`. */
import type { Refines, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { explore } from "./explore.ts";
import { createFakePlatform, type FakeHandler } from "./fake-platform.ts";
import { observeCore, summarize } from "./observe.ts";

/** A core module as a bundler presents it: exports as configurable getters. */
function coreModule() {
  const decide = (rows: number): boolean => rows === 0;
  const ns = {};
  Object.defineProperty(ns, "decide", { enumerable: true, configurable: true, get: () => decide });
  return ns as { readonly decide: (rows: number) => boolean };
}

const follows: Refines = {
  kind: "refines",
  name: "insert-follows-decision",
  decision: "decide",
  effect: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
  state: {
    read: { target: "D1:DB", op: "first", kind: "result" },
    write: { target: "D1:DB", op: "run", kind: "result", atLeast: { "result.changes": 1 } },
    key: "args.params.0",
  },
};

const spec = (maxConcurrentInvocations: number): ScenarioSpec => ({
  version: 1,
  name: "fake",
  worker: { entry: "./w.ts", config: "./w.jsonc" },
  drive: {
    kind: "queue",
    queue: "q",
    messages: [
      { id: "m1", body: { orderId: "o-1" } },
      { id: "m2", body: { orderId: "o-1" } },
    ],
  },
  setup: [],
  externals: [],
  invariants: [follows],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations, budgetMs: 60_000 },
});

describe("observeCore", () => {
  test("records calls made during runs and logs them as decisions of their invocation", async () => {
    const core = coreModule();
    const consumer: FakeHandler = async (message, env) => {
      const orderId = (message.body as { orderId: string }).orderId;
      if (core.decide(await env.count(orderId))) await env.insert(orderId);
      message.ack();
    };
    core.decide(5); // Outside any run: not an input the simulator passed.
    const observer = observeCore(core, ["decide"]);
    try {
      const verdict = await explore(spec(1), createFakePlatform(consumer), {
        seed: 0,
        maxRuns: 1,
        leakCheckRuns: 0,
      });
      expect(verdict.kind).toBe("BOUNDED");
      expect(observer.calls.map((c) => c.args)).toEqual([[0], [1]]);
    } finally {
      observer.restore();
    }
    expect(core.decide(0)).toBe(true);
    expect(observer.calls).toHaveLength(2);
  });

  test("refines catches the check-then-insert race as a decision made on a stale read", async () => {
    const core = coreModule();
    const consumer: FakeHandler = async (message, env) => {
      const orderId = (message.body as { orderId: string }).orderId;
      if (core.decide(await env.count(orderId))) await env.insert(orderId);
      message.ack();
    };
    const observer = observeCore(core, ["decide"]);
    try {
      const verdict = await explore(spec(2), createFakePlatform(consumer, { concurrent: true }), {
        seed: 0,
        exhaustive: true,
        leakCheckRuns: 0,
      });
      expect(verdict.kind).toBe("VIOLATED");
      if (verdict.kind !== "VIOLATED") return;
      expect(verdict.violation.keys[0]).toBe("stale_read");
      const decisions = verdict.trace.entries.filter((e) => e.target === "Core:decide");
      expect(decisions.map((d) => d.payload)).toEqual([
        { args: [0], result: true },
        { args: [0], result: true },
      ]);
      expect(new Set(decisions.map((d) => d.invocation)).size).toBe(2);
    } finally {
      observer.restore();
    }
  });

  test("a core function that returns a promise is not a pure decision: the run is UNSUPPORTED", async () => {
    const decide = async (rows: number): Promise<boolean> => rows === 0;
    const core = {};
    Object.defineProperty(core, "decide", {
      enumerable: true,
      configurable: true,
      get: () => decide,
    });
    const ns = core as { readonly decide: (rows: number) => Promise<boolean> };
    const consumer: FakeHandler = async (message, env) => {
      const orderId = (message.body as { orderId: string }).orderId;
      if (await ns.decide(await env.count(orderId))) await env.insert(orderId);
      message.ack();
    };
    const observer = observeCore(ns, ["decide"]);
    try {
      const verdict = await explore(spec(1), createFakePlatform(consumer), {
        seed: 0,
        maxRuns: 1,
        leakCheckRuns: 0,
      });
      expect(verdict.kind).toBe("UNSUPPORTED");
      if (verdict.kind === "UNSUPPORTED")
        expect(verdict.reason).toContain("decide returned a promise");
    } finally {
      observer.restore();
    }
  });

  test("a frozen namespace cannot be observed, and says so", () => {
    const ns = Object.freeze({ decide: (n: number) => n === 0 });
    const observer = observeCore(ns, ["decide", "missing"]);
    expect(Object.keys(observer.unobservable).sort()).toEqual(["decide", "missing"]);
    expect(observer.unobservable["missing"]).toContain("no function");
  });
});

describe("summarize", () => {
  test("JSON as is, everything else as a readable string", () => {
    expect(summarize({ a: [1, "x", true, null], b: undefined })).toEqual({
      a: [1, "x", true, null],
      b: null,
    });
    expect(summarize([Number.NaN, -0, 3n, () => 1])).toEqual(["NaN", "-0", "3n", "[function]"]);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(summarize(cyclic)).toEqual({ self: "[…]" });
    const own = summarize(JSON.parse('{"__proto__":{"approved":true}}'));
    expect(Object.hasOwn(own as object, "__proto__")).toBe(true);
  });
});
