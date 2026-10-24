import type { JsonValue, ScenarioSpec } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { compareSides, proxiedSide } from "./differential.ts";
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
