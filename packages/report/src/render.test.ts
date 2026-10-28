import {
  appendEffect,
  type Bounded,
  emptyLog,
  type SpecVerdict,
  type Unsupported,
  type Violated,
} from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { emitRegressionTest } from "./regression.ts";
import {
  renderJson,
  renderSpecReport,
  renderSpecReportJson,
  renderSpecs,
  renderText,
  renderTrace,
} from "./render.ts";

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

  test("an exhaustive VIOLATED or UNSUPPORTED says it was exhaustive and where it stopped", () => {
    const exhaustive = { complete: false, schedules: 4, reduction: true };
    expect(renderText({ ...violated, reached: { ...violated.reached, exhaustive } })).toMatch(
      /\nExplored: .*\nExhaustive: stopped at the first violation \(4 schedules, partial-order reduction\)\n/,
    );
    const u: Unsupported = {
      kind: "UNSUPPORTED",
      scenario: "s",
      seed: 1,
      cause: "not_replayable",
      reason: "exhaustive exploration needs deterministic runs",
      reached: { runs: 2, effectPoints: 2, faultsInjected: 0, elapsedMs: 5, exhaustive },
      assumptions: [],
    };
    expect(renderText(u)).toContain(
      "Exhaustive: stopped where the scenario could not be decided (4 schedules, partial-order reduction)",
    );
    expect(renderText(violated)).not.toContain("Exhaustive:");
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

describe("spec verdicts", () => {
  const bounded: Bounded = {
    kind: "BOUNDED",
    scenario: "s",
    seed: 1,
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
    reached: { runs: 1, effectPoints: 1, faultsInjected: 0, elapsedMs: 1 },
    assumptions: [],
  };
  const base = { module: "./domain.ts", function: "decideRefund", assumptions: [] };
  const specs: SpecVerdict[] = [
    {
      ...base,
      property: "a",
      text: "forall (x: int) { x === x }",
      kind: "CHECKED",
      inputs: 3,
      discarded: 1,
    },
    {
      ...base,
      property: "b",
      text: "forall (c r a: int) {\n  f(c, r, a) }",
      kind: "REFUTED",
      rung: "CHECKED",
      counterexample: {
        binders: [
          { name: "c", value: "1000" },
          { name: "r", value: "800" },
          { name: "a", value: "400" },
        ],
        call: "decideRefund(1000, 800, 400)",
      },
    },
    {
      ...base,
      property: "c",
      text: "forall (x: int) { g(x) }",
      kind: "TESTED",
      inputs: 100,
      discarded: 7,
      seed: "corpus",
      checked: 2,
    },
    {
      ...base,
      property: "d",
      text: "forall (x: int) { h(x) }",
      kind: "REFUTED",
      rung: "TESTED",
      counterexample: { binders: [{ name: "x", value: "1" }] },
    },
    {
      ...base,
      property: "c2",
      text: "forall (x: int) { g2(x) }",
      kind: "TESTED",
      inputs: 100,
      discarded: 0,
      seed: "corpus",
      assumptions: [
        "sampled",
        "not PROVEN by lean: unavailable: no Lean toolchain found; install elan",
      ],
    },
    {
      ...base,
      property: "e",
      text: "forall (x: int) { e(x) }",
      kind: "PROVEN",
      engine: { name: "lean", version: "4.35.0" },
      tested: 100,
      checked: 2,
      assumptions: ["number is modelled as the unbounded integers", "sampled with seed corpus"],
    },
    {
      ...base,
      property: "f",
      text: "forall (x: int) { f(x) }",
      kind: "CONFLICT",
      proven: { name: "lean", version: "4.35.0" },
      refuted: {
        name: "other",
        version: "1",
        counterexample: { binders: [{ name: "x", value: "7" }] },
      },
    },
    {
      ...base,
      property: "decideRefundTotal",
      text: "total(decideRefund)",
      kind: "UNKNOWN",
      cause: "unsupported",
      reason: "needs a prover",
    },
  ];

  test("text: one line each, the counterexample under a refutation", () => {
    expect(renderSpecs(specs).split("\n")).toEqual([
      "Specs (CHECKED means held on the inputs the simulator passed, TESTED on generated ones too; neither is a proof. PROVEN is one, by the named engine)",
      "  CHECKED  decideRefund a: held on 3 input(s), 1 outside the claim",
      "  REFUTED  decideRefund b: false at decideRefund(1000, 800, 400)",
      "           c = 1000, r = 800, a = 400",
      "           forall (c r a: int) { f(c, r, a) }",
      "  TESTED   decideRefund c: held on 100 generated input(s) and 2 the simulator passed, 7 outside the claim",
      "  REFUTED  decideRefund d: false on a generated input",
      "           x = 1",
      "           forall (x: int) { h(x) }",
      "  TESTED   decideRefund c2: held on 100 generated input(s)",
      "           not PROVEN by lean: unavailable: no Lean toolchain found; install elan",
      "  PROVEN   decideRefund e: by lean 4.35.0; also held on 100 generated input(s) and 2 the simulator passed",
      "           number is modelled as the unbounded integers",
      "           sampled with seed corpus",
      "  CONFLICT decideRefund f: lean 4.35.0 proves it, other 1 refutes it; not resolved automatically",
      "           x = 7",
      "  UNKNOWN  decideRefund decideRefundTotal: unsupported: needs a prover",
    ]);
    expect(renderSpecs([])).toBe("");
  });

  test("JSON: beside the scenario verdict, only when there are any", () => {
    const verdict = JSON.parse(renderJson(bounded)) as Record<string, unknown>;
    expect("specs" in verdict).toBe(false);
    const withSpecs = JSON.parse(renderJson(bounded, specs)) as { specs: { kind: string }[] };
    expect(withSpecs.specs.map((s) => s.kind)).toEqual([
      "CHECKED",
      "REFUTED",
      "TESTED",
      "REFUTED",
      "TESTED",
      "PROVEN",
      "CONFLICT",
      "UNKNOWN",
    ]);
  });

  test("report text: verdicts grouped by module, and a count by verdict", () => {
    const other: SpecVerdict = {
      ...base,
      module: "./billing/domain.ts",
      function: "charge",
      property: "p",
      text: "p",
      kind: "TESTED",
      inputs: 100,
      discarded: 0,
      seed: "report",
    };
    const lines = renderSpecReport([...specs, other]).split("\n");
    // No scenario ran, so the header explains only the rungs a report reaches.
    expect(lines[0]).toBe(
      "Specs (TESTED means held on inputs generated from the parameter types, which is not a proof; PROVEN is one, by the named engine)",
    );
    expect(lines.slice(1, 4)).toEqual([
      "",
      "./domain.ts",
      "  CHECKED  decideRefund a: held on 3 input(s), 1 outside the claim",
    ]);
    const billing = lines.indexOf("./billing/domain.ts");
    expect(lines.slice(billing - 1, billing + 2)).toEqual([
      "",
      "./billing/domain.ts",
      "  TESTED   charge p: held on 100 generated input(s)",
    ]);
    expect(lines.at(-1)).toBe(
      "9 properties in 2 modules: 1 PROVEN, 3 TESTED, 1 CHECKED, 2 REFUTED, 1 CONFLICT, 1 UNKNOWN",
    );
    expect(renderSpecReport([])).toBe("No specs found.");
  });

  test("report JSON: canonical, versioned, the spec verdicts only", () => {
    const report = JSON.parse(renderSpecReportJson(specs)) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual(["generator", "schemaVersion", "specs"]);
    expect(report["schemaVersion"]).toBe(1);
    expect((report["specs"] as unknown[]).length).toBe(specs.length);
  });
});
