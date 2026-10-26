import type { SpecVerdict } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { aggregate, type EngineReport, type ProofOutcome } from "./provers.ts";

const base = { module: "./domain.ts", function: "f", text: "forall (x: int) { f(x) >= 0 }" };
const tested: SpecVerdict = {
  ...base,
  property: "p",
  kind: "TESTED",
  inputs: 100,
  discarded: 3,
  seed: "s",
  checked: 2,
  assumptions: ["sampled"],
};
const checked: SpecVerdict = {
  ...base,
  property: "p",
  kind: "CHECKED",
  inputs: 2,
  discarded: 0,
  assumptions: [],
};
const unknownTotal: SpecVerdict = {
  ...base,
  property: "fTotal",
  text: "fTotal",
  kind: "UNKNOWN",
  cause: "unsupported",
  reason: "needs a prover",
  assumptions: [],
};
const refutedBySimulator: SpecVerdict = {
  ...base,
  property: "p",
  kind: "REFUTED",
  rung: "CHECKED",
  counterexample: { binders: [{ name: "x", value: "-1" }], call: "f(-1)" },
  assumptions: [],
};
const lean = { name: "lean", version: "4.35.0" };
const report = (engine: string, outcomes: Record<string, ProofOutcome>): EngineReport => ({
  engine,
  proofs: {
    results: Object.entries(outcomes).map(([property, outcome]) => ({
      function: "f",
      property,
      outcome,
    })),
    specErrors: [],
  },
});
const proven: ProofOutcome = { kind: "PROVEN", engine: lean, assumptions: ["integers"] };
const gaveUp: ProofOutcome = { kind: "UNKNOWN", cause: "gave_up", reason: "omega failed" };
const refutes: ProofOutcome = {
  kind: "REFUTED",
  engine: { name: "other", version: "1" },
  counterexample: { binders: [{ name: "x", value: "7" }] },
  assumptions: [],
};

describe("aggregate", () => {
  test("an engine proving lifts TESTED and CHECKED to PROVEN, keeping their counts", () => {
    const [p] = aggregate("./domain.ts", [tested], [report("lean", { p: proven })]);
    expect(p).toMatchObject({ kind: "PROVEN", engine: lean, tested: 100, checked: 2 });
    expect(p?.assumptions).toEqual(["integers", "sampled"]);
    const [c] = aggregate("./domain.ts", [checked], [report("lean", { p: proven })]);
    expect(c).toMatchObject({ kind: "PROVEN", checked: 2 });
    expect(c && "tested" in c).toBe(false);
  });

  test("fTotal is proved by the engine where the rungs could not decide", () => {
    const [t] = aggregate("./domain.ts", [unknownTotal], [report("lean", { fTotal: proven })]);
    expect(t).toMatchObject({ kind: "PROVEN", property: "fTotal" });
  });

  test("an engine falling short leaves the verdict, with why", () => {
    const [p] = aggregate("./domain.ts", [tested], [report("lean", { p: gaveUp })]);
    expect(p).toMatchObject({ kind: "TESTED", inputs: 100 });
    expect(p?.assumptions.at(-1)).toBe("not PROVEN by lean: gave_up: omega failed");
    const [u] = aggregate("./domain.ts", [unknownTotal], [report("lean", { fTotal: gaveUp })]);
    expect(u).toMatchObject({ kind: "UNKNOWN", cause: "unsupported" });
  });

  test("the simulator's counterexample stands; an engine proving against it is a CONFLICT", () => {
    const [r] = aggregate("./domain.ts", [refutedBySimulator], [report("lean", { p: gaveUp })]);
    expect(r).toMatchObject({ kind: "REFUTED", rung: "CHECKED" });
    const [c] = aggregate("./domain.ts", [refutedBySimulator], [report("lean", { p: proven })]);
    expect(c).toMatchObject({
      kind: "CONFLICT",
      proven: lean,
      refuted: { name: "simulator", version: "CHECKED", counterexample: { call: "f(-1)" } },
    });
  });

  test("engines disagreeing is a CONFLICT; one refuting alone is REFUTED at the PROVEN rung", () => {
    const [c] = aggregate(
      "./domain.ts",
      [tested],
      [report("lean", { p: proven }), report("other", { p: refutes })],
    );
    expect(c).toMatchObject({ kind: "CONFLICT", proven: lean, refuted: { name: "other" } });
    const [r] = aggregate("./domain.ts", [tested], [report("other", { p: refutes })]);
    expect(r).toMatchObject({
      kind: "REFUTED",
      rung: "PROVEN",
      engine: { name: "other" },
      counterexample: { binders: [{ name: "x", value: "7" }] },
    });
  });

  test("verdicts of other modules, and properties no engine reported on, pass through", () => {
    const other: SpecVerdict = { ...tested, module: "./other.ts" };
    expect(aggregate("./domain.ts", [other, tested], [report("lean", {})])).toEqual([
      other,
      tested,
    ]);
  });
});
