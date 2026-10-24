import {
  appendEffect,
  type Bounded,
  emptyLog,
  type Unsupported,
  type Violated,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { emitRegressionTest } from "./regression.ts";
import { renderJson, renderText, renderTrace } from "./render.ts";

let trace = appendEffect(emptyLog, {
  kind: "call",
  invocation: "msg-1#1",
  target: "D1:DB",
  op: "run",
  payload: { args: { sql: "INSERT", params: ["o-1", 1200] } },
});
trace = appendEffect(trace, {
  kind: "result",
  invocation: "msg-1#1",
  target: "D1:DB",
  op: "run",
  payload: { args: { sql: "INSERT", params: ["o-1", 1200] }, result: { changes: 1 } },
});
trace = appendEffect(trace, {
  kind: "fault",
  invocation: "msg-1#1",
  target: "Queue:payments",
  op: "ack",
  payload: { args: { messageId: "msg-1", implicit: false }, fault: "crash_before" },
});
trace = appendEffect(trace, {
  kind: "result",
  invocation: "msg-1#2",
  target: "D1:DB",
  op: "run",
  payload: { args: { sql: "INSERT", params: ["o-1", 1200] }, result: { changes: 1 } },
});

const violated: Violated = {
  kind: "VIOLATED",
  scenario: "queue-duplicate-write",
  seed: "corpus",
  violation: {
    invariant: "payment-recorded-once",
    message: 'D1:DB run happened twice for key "o-1" (seq 1 and 3)',
    keys: ['"o-1"'],
    evidence: [1, 3],
  },
  trace,
  schedule: {
    seed: 42,
    faults: [
      {
        invocation: "msg-1#1",
        ordinal: 1,
        fault: "crash_before",
        target: "Queue:payments",
        op: "ack",
      },
    ],
  },
  keptEvents: ["msg-1"],
  shrunk: { faultsRemoved: 0, eventsRemoved: 1, runs: 3 },
  reached: { runs: 6, effectPoints: 40, faultsInjected: 4, elapsedMs: 120 },
  assumptions: ["one invocation at a time"],
};

describe("renderText", () => {
  test("shows the violation, the schedule, the shrink stats and the marked trace", () => {
    const text = renderText(violated);
    expect(text).toContain("VIOLATED  queue-duplicate-write  (seed corpus)");
    expect(text).toContain("Invariant payment-recorded-once is violated");
    expect(text).toContain("crash_before at msg-1#1 effect #1 (Queue:payments ack)");
    expect(text).toContain("Shrunk: 1 event(s) and 0 fault(s) removed in 3 run(s)");
    expect(text).toContain("Explored: 6 run(s), 40 effect point(s), 4 fault(s) injected, 120 ms");
    expect(text).toContain("  - one invocation at a time");
    const marked = text.split("\n").filter((l) => l.startsWith("*"));
    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain("msg-1#1");
    expect(marked[1]).toContain("msg-1#2");
  });

  test("BOUNDED says it is not a proof and states the bounds", () => {
    const bounded: Bounded = {
      kind: "BOUNDED",
      scenario: "s",
      seed: 1,
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 2,
        maxConcurrentInvocations: 1,
        budgetMs: 2000,
      },
      reached: { runs: 100, effectPoints: 900, faultsInjected: 50, elapsedMs: 800 },
      assumptions: [],
    };
    const text = renderText(bounded);
    expect(text).toContain("This is not a proof.");
    expect(text).toContain("faults per run ≤ 1, redeliveries ≤ 2");
  });

  test("an exhaustive BOUNDED says whether every schedule ran", () => {
    const bounded: Bounded = {
      kind: "BOUNDED",
      scenario: "s",
      seed: 1,
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 0,
        maxConcurrentInvocations: 2,
        budgetMs: 2000,
      },
      reached: {
        runs: 12,
        effectPoints: 40,
        faultsInjected: 8,
        elapsedMs: 50,
        exhaustive: { complete: true, schedules: 10, reduction: true },
      },
      assumptions: [],
    };
    expect(renderText(bounded)).toContain(
      "Exhaustive: every schedule within the bounds ran (10 schedules, partial-order reduction)",
    );
    const partial = {
      ...bounded,
      reached: {
        ...bounded.reached,
        exhaustive: { complete: false, schedules: 3, reduction: false },
      },
    };
    expect(renderText(partial)).toContain(
      "stopped at the budget before every schedule ran (3 schedules)",
    );
  });

  test("UNSUPPORTED names the cause", () => {
    const u: Unsupported = {
      kind: "UNSUPPORTED",
      scenario: "s",
      seed: 1,
      cause: "unsupported_api",
      reason: "binding KV is not proxied",
      reached: { runs: 1, effectPoints: 2, faultsInjected: 0, elapsedMs: 5 },
      assumptions: [],
    };
    expect(renderText(u)).toContain("(unsupported_api): binding KV is not proxied");
  });
});

describe("renderTrace", () => {
  test("is a table with one row per effect", () => {
    const lines = renderTrace(trace, [3]).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\s+seq\s+invocation\s+kind\s+target\s+op\s+payload$/);
    expect(lines[4]?.startsWith("*")).toBe(true);
  });
});

describe("renderJson", () => {
  test("is canonical JSON with a schema version and the whole verdict", () => {
    const json = renderJson(violated);
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      generator: string;
      verdict: Violated;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.generator).toBe("eutaxy");
    expect(parsed.verdict.kind).toBe("VIOLATED");
    expect(parsed.verdict.trace.entries).toHaveLength(4);
    expect(json.startsWith('{"generator":"eutaxy","schemaVersion":1,"verdict":')).toBe(true);
  });
});

describe("emitRegressionTest", () => {
  const options = {
    imports: [
      'import scenario from "./scenario.sim.ts";',
      'import { fakePlatform } from "./fake.ts";',
    ],
    platform: "fakePlatform()",
    scenario: "scenario",
  };

  test("emits a test that replays the shrunk schedule and expects the invariants to hold", () => {
    const src = emitRegressionTest(violated, options);
    expect(src).toContain('import { checkInvariants, replay, restrictSpec } from "eutaxy";');
    expect(src).toContain('import scenario from "./scenario.sim.ts";');
    expect(src).toContain(
      'const schedule = {"faults":[{"fault":"crash_before","invocation":"msg-1#1","op":"ack","ordinal":1,"target":"Queue:payments"}],"seed":42} as const;',
    );
    expect(src).toContain('const keptEvents = ["msg-1"] as const;');
    expect(src).toContain("restrictSpec(platform, scenario, keptEvents)");
    expect(src).toContain("toEqual([])");
    expect(src).toContain("holds on the recorded schedule");
  });

  test("can instead assert the recorded violation, for corpora", () => {
    const src = emitRegressionTest(violated, {
      ...options,
      expect: "violates",
      engineModule: "@eutaxy/engine",
    });
    expect(src).toContain('from "@eutaxy/engine"');
    expect(src).toContain('toContainEqual(["payment-recorded-once", ["\\"o-1\\""]])');
    expect(src).toContain("is still violated");
  });
});
