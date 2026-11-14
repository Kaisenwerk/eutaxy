import { describe, expect, test } from "vitest";
import { unhandledErrorsFile, vitestFailure } from "./vitest-failure.ts";

const report = (files: unknown[]) => JSON.stringify({ success: false, testResults: files });

describe("why Vitest failed a check's run", () => {
  test("a test file that could not run says why", () => {
    const why = vitestFailure({
      report: report([{ status: "failed", message: "boom as it loads", assertionResults: [] }]),
    });
    expect(why).toContain("the check's test file could not run: boom as it loads");
  });

  test("a failed test gives its error, cut to its first lines", () => {
    const stack = ["Error: the run broke", ...Array.from({ length: 30 }, (_, i) => `    at f${i}`)];
    const why = vitestFailure({
      report: report([
        {
          status: "failed",
          message: "",
          assertionResults: [
            { status: "failed", fullName: "check", failureMessages: [stack.join("\n")] },
          ],
        },
      ]),
    });
    expect(why).toContain("the check's test failed: Error: the run broke");
    expect(why).toContain("    at f0");
    expect(why).not.toContain("    at f29");
  });

  test("errors nothing handled are told once each, with how often they came", () => {
    const e = { type: "Unhandled Rejection", stack: "Error: stray\n    at fetch (w.ts:3:25)" };
    const why = vitestFailure({
      report: report([
        {
          status: "passed",
          message: "",
          assertionResults: [{ status: "passed", fullName: "check", failureMessages: [] }],
        },
      ]),
      unhandled: JSON.stringify([e, e, e, { type: "Unhandled Error", message: "other" }]),
    });
    expect(why).toContain("its test passed");
    expect(why).toContain("4 errors nothing handled, 2 distinct");
    expect(why).toContain(
      "Unhandled Rejection (3 times): Error: stray\n      at fetch (w.ts:3:25)",
    );
    expect(why).toContain("Unhandled Error: other");
  });

  test("an error outside the file's tests is told, whatever the tests did", () => {
    const passed = [{ status: "passed", fullName: "check", failureMessages: [] }];
    const why = vitestFailure({
      report: report([{ status: "failed", message: "teardown broke", assertionResults: passed }]),
      unhandled: JSON.stringify([{ type: "Unhandled Rejection", message: "stray" }]),
    });
    expect(why).toContain("the check's test file failed outside its test: teardown broke");
    expect(why).not.toContain("its test passed");
    expect(why).toContain("1 error nothing handled:");
  });

  test("errors whose fields are not text are told as data, not a crash", () => {
    const why = vitestFailure({
      report: report([
        {
          status: "failed",
          message: { code: 1 },
          assertionResults: [{ status: "failed", failureMessages: [{ deep: true }] }],
        },
      ]),
      unhandled: JSON.stringify([{ type: "Unhandled Rejection", message: { a: 1 }, stack: 7 }]),
    });
    expect(why).toContain('{"code":1}');
    expect(why).toContain('{"deep":true}');
    expect(why).toContain('Unhandled Rejection: {"a":1}');
  });

  test("a test that passed and left no verdict says so", () => {
    const why = vitestFailure({
      report: report([
        {
          status: "passed",
          message: "",
          assertionResults: [{ status: "passed", fullName: "check", failureMessages: [] }],
        },
      ]),
    });
    expect(why).toContain("its test passed but left no verdict");
  });

  test("with no report, or one that says nothing, it says so", () => {
    expect(vitestFailure({})).toContain("Vitest left no report");
    expect(vitestFailure({ report: "{not json" })).toContain("Vitest left no report");
    expect(vitestFailure({ report: report([]) })).toContain(
      "Vitest reported no failed test and no error nothing handled",
    );
  });

  test("the unhandled errors go beside the report, under its stamp", () => {
    expect(unhandledErrorsFile("/p/.eutaxy/vitest-report.12-ab.json")).toBe(
      "/p/.eutaxy/vitest-report.12-ab.unhandled.json",
    );
  });
});
