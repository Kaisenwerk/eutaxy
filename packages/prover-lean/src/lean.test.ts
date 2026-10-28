import { describe, expect, test } from "vitest";
import { diagnostics, jsonDiagnostics } from "./lean.ts";

describe("diagnostics", () => {
  test("file:line:col: severity: message, continuation lines kept with their diagnostic", () => {
    const out = diagnostics(
      [
        "Eutaxy.lean:44:25: error: omega could not prove the goal:",
        "a possible counterexample may satisfy the constraints",
        "  a ≥ 1",
        "Eutaxy.lean:50:2: warning: declaration uses 'sorry'",
        "/tmp/x/Eutaxy.lean:3:0: info: fine",
        "",
      ].join("\n"),
    );
    expect(out).toEqual([
      {
        line: 44,
        column: 25,
        severity: "error",
        message:
          "omega could not prove the goal:\na possible counterexample may satisfy the constraints\n  a ≥ 1",
      },
      { line: 50, column: 2, severity: "warning", message: "declaration uses 'sorry'" },
      { line: 3, column: 0, severity: "info", message: "fine" },
    ]);
    expect(diagnostics("")).toEqual([]);
  });
});

describe("jsonDiagnostics", () => {
  test("Lean's messages with their positions; anything else written is not one", () => {
    const out = [
      '{"data":"unsolved goals","pos":{"line":4,"column":19},"severity":"error"}',
      "'t' does not depend on any axioms",
      `{"data":"'t' depends on axioms: [propext]","pos":{"line":9,"column":0},"severity":"information"}`,
      "{not json",
    ].join("\n");
    expect(jsonDiagnostics(out)).toEqual([
      { line: 4, column: 19, severity: "error", message: "unsolved goals" },
      { line: 9, column: 0, severity: "info", message: "'t' depends on axioms: [propext]" },
    ]);
  });
});
