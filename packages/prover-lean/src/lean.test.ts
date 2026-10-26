import { describe, expect, test } from "vitest";
import { diagnostics } from "./lean.ts";

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
