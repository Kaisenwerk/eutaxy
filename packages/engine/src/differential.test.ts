import type { EventRef, JsonValue, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { virtualEpoch } from "./clock.ts";
import { compareSides, DifferentialStuck, proxiedSide, rawRun } from "./differential.ts";
import { buggyConsumer, createFakePlatform } from "./fake-platform.ts";

const spec: ScenarioSpec = {
  version: 1,
  name: "fake-differential",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: {
    kind: "queue",
    queue: "q",
    messages: [
      { id: "m1", body: { orderId: "o-1" } },
      { id: "m2", body: { orderId: "o-2" } },
    ],
  },
  setup: [],
  externals: [],
  invariants: [],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 2, budgetMs: 10_000 },
};

describe("proxiedSide", () => {
  test("delivers one event at a time with no faults and hands over each delivery's entries", async () => {
    const platform = createFakePlatform(buggyConsumer, { concurrent: true });
    const side = await proxiedSide(spec, platform, (event, result, entries) => ({
      event: event.id,
      status: result.status,
      ops: entries.filter((e) => e.kind === "result").map((e) => e.op),
    }));
    expect(side.attempts).toEqual([
      { event: "m1", status: "completed", ops: ["run", "ack"] },
      { event: "m2", status: "completed", ops: ["run", "ack"] },
    ]);
    expect(side.unsupported).toEqual([]);
    expect(platform.rows.get("o-1")).toBe(1);
  });

  test("calls a class platform's methods on the platform itself", async () => {
    const literal = createFakePlatform(buggyConsumer);
    class ClassPlatform {
      readonly name = "class";
      readonly assumptions = [];
      #resets = 0;
      reset(s: ScenarioSpec) {
        this.#resets++;
        return literal.reset(s);
      }
      get resets() {
        return this.#resets;
      }
      initialEvents(s: ScenarioSpec) {
        return literal.initialEvents(s);
      }
      deliver(...args: Parameters<typeof literal.deliver>) {
        return literal.deliver(...args);
      }
      restrictEvents(s: ScenarioSpec, keep: readonly string[]) {
        return literal.restrictEvents(s, keep);
      }
    }
    const platform = new ClassPlatform();
    const side = await proxiedSide(spec, platform, (event) => event.id);
    expect(side.attempts).toEqual(["m1", "m2"]);
    expect(platform.resets).toBe(1);
  });
});

describe("rawRun", () => {
  const event = (id: string, at?: number): EventRef => ({
    id,
    attempt: 1,
    data: null,
    ...(at === undefined ? {} : { at }),
  });

  test("delivers the earliest due event first, time moved to it, and an unhandled one again while the limits leave room", async () => {
    const realNow = Date.now;
    const seen: string[] = [];
    const times: number[] = [];
    let restoredUnderPatchedGlobals = false;
    const attempts = await rawRun(spec, {
      events: [event("late", virtualEpoch + 5_000), event("m1")],
      limit: 1,
      install: (ctx) => ({
        attempt: async (e) => {
          seen.push(`${e.id}#${e.attempt}`);
          times.push(Date.now());
          const ran = await ctx.call(async () => {
            if (e.id === "m1") throw new Error("not this time");
            return e.id;
          });
          return {
            record: `${e.id}#${e.attempt}:${ran.status}`,
            handled: ran.status === "completed",
          };
        },
        restore: () => {
          restoredUnderPatchedGlobals = Date.now !== realNow;
        },
      }),
    });
    // m1 twice (its limit is one redelivery; the spec allows two), then the tick once the clock reached it.
    expect(attempts).toEqual(["m1#1:errored", "m1#2:errored", "late#1:completed"]);
    expect(seen).toEqual(["m1#1", "m1#2", "late#1"]);
    expect(times).toEqual([virtualEpoch, virtualEpoch, virtualEpoch + 5_000]);
    expect(restoredUnderPatchedGlobals).toBe(true);
    expect(Date.now).toBe(realNow);
  });

  test("a platform that cannot install its raw side leaves the globals as they were", async () => {
    const realNow = Date.now;
    const realFetch = globalThis.fetch;
    await expect(
      rawRun(spec, {
        events: [event("m1")],
        limit: 0,
        install: () => {
          throw new Error("the Worker has no fetch() handler");
        },
      }),
    ).rejects.toThrow("the Worker has no fetch() handler");
    expect(Date.now).toBe(realNow);
    expect(globalThis.fetch).toBe(realFetch);
  });

  test("a handler waiting on nothing ends the comparison, as does anything the raw side could not control", async () => {
    await expect(
      rawRun(spec, {
        events: [event("m1")],
        limit: 0,
        install: (ctx) => ({
          attempt: async () => {
            await ctx.call(() => new Promise<never>(() => {}));
            return { record: null, handled: true };
          },
        }),
      }),
    ).rejects.toBeInstanceOf(DifferentialStuck);
    await expect(
      rawRun(spec, {
        events: [event("m1")],
        limit: 0,
        install: (ctx) => ({
          attempt: async (e) => {
            ctx.unsupported("binding KV is not proxied");
            return { record: e.id, handled: true };
          },
        }),
      }),
    ).rejects.toThrow("raw side: binding KV is not proxied");
  });
});

describe("compareSides", () => {
  const side = {
    attempts: [{ event: "m1", status: "completed" }],
    state: { "DB.payments": [{ id: 1 }] },
  };

  test("agreeing sides have no differences", () => {
    expect(compareSides(side, side, [])).toEqual([]);
  });

  test("compares attempts and state rows as they are, however deep", () => {
    const nested = (leaf: number): JsonValue => {
      let v: JsonValue = { n: leaf };
      for (let i = 0; i < 10; i++) v = { v };
      return v;
    };
    const one = { attempts: [], state: { t: [nested(1)] } };
    const two = { attempts: [], state: { t: [nested(2)] } };
    expect(compareSides(one, two, [])).toHaveLength(1);
    const first = { attempts: [nested(1)], state: {} };
    const second = { attempts: [nested(2)], state: {} };
    expect(compareSides(first, second, [])).toHaveLength(1);
  });

  test("names differing attempts, differing or missing state, and unsupported APIs", () => {
    const other = { attempts: [{ event: "m1", status: "errored" }], state: { "DB.other": [] } };
    const differences = compareSides(side, other, ["binding KV is not proxied"]);
    expect(differences).toEqual([
      "the proxied run touched unsupported APIs: binding KV is not proxied",
      'attempts differ:\n  eutaxy [{"event":"m1","status":"completed"}]\n  raw    [{"event":"m1","status":"errored"}]',
      'DB.payments differs:\n  eutaxy [{"id":1}]\n  raw    []',
    ]);
  });
});
