import { describe, expect, test } from "vitest";
import { strayErrors, strayNote, unhandledErrorsFile, vitestFailure } from "./vitest-failure.ts";

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

  test("a test that passed and left no verdict is the cause, not the errors the test's runtime caught", () => {
    const why = vitestFailure({
      report: report([
        {
          status: "passed",
          message: "",
          assertionResults: [{ status: "passed", fullName: "check", failureMessages: [] }],
        },
      ]),
      unhandled: JSON.stringify([{ type: "Unhandled Rejection", message: "stray" }]),
    });
    expect(why).toContain("its test passed but left no verdict in Vitest's report");
    expect(why).toContain("there was also 1 error nothing handled:");
    expect(why).not.toContain("Vitest fails a run on any error");
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

  test("a failed test with no message is still told as failed", () => {
    const why = vitestFailure({
      report: report([
        {
          status: "failed",
          message: "",
          assertionResults: [{ status: "failed", fullName: "check" }],
        },
      ]),
    });
    expect(why).toContain("the check's test failed");
    expect(why).not.toContain("no failed test");
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

describe("errors nothing handled beside a test that passed", () => {
  const passedTest = { status: "passed", fullName: "check", failureMessages: [] };
  const passedFile = { status: "passed", message: "", assertionResults: [passedTest] };
  const stray = { type: "Unhandled Rejection", stack: "Error: stray\n    at fetch (w.ts:3:25)" };

  test("that differ only past the lines told are still told apart", () => {
    const deep = (frame: string) => ({
      type: "Unhandled Rejection",
      stack: [
        "Error: deep",
        ...Array.from({ length: 10 }, (_, i) => `    at f${i}`),
        `    at ${frame}`,
      ].join("\n"),
    });
    const errors = strayErrors({
      report: report([passedFile]),
      unhandled: JSON.stringify([deep("a"), deep("b"), deep("a")]),
    });
    expect(errors?.map((e) => e.times)).toEqual([2, 1]);
  });

  test("are the only fault: told once each, with how often they came", () => {
    const errors = strayErrors({
      report: report([passedFile]),
      unhandled: JSON.stringify([stray, stray, { type: "Uncaught Exception", message: "other" }]),
    });
    expect(errors).toEqual([
      { type: "Unhandled Rejection", message: "Error: stray\nat fetch (w.ts:3:25)", times: 2 },
      { type: "Uncaught Exception", message: "other", times: 1 },
    ]);
    expect(strayNote(errors ?? [])).toBe(
      "note: the check's test passed, and its verdict stands, but there were 3 errors nothing handled, 2 distinct (Cloudflare's runtime only logs them; Vitest fails the run on them):\n" +
        "    Unhandled Rejection (2 times): Error: stray\n      at fetch (w.ts:3:25)\n" +
        "    Uncaught Exception: other\n",
    );
  });

  test("leave no verdict standing beside any other fault, or without a passed test", () => {
    const unhandled = JSON.stringify([stray]);
    const failedTest = { status: "failed", fullName: "check", failureMessages: ["broke"] };
    for (const files of [
      [{ status: "failed", message: "teardown broke", assertionResults: [passedTest] }],
      [{ status: "failed", message: "", assertionResults: [failedTest] }],
      [passedFile, { status: "failed", message: "", assertionResults: [failedTest] }],
      [{ status: "passed", message: "", assertionResults: [] }],
      [],
    ])
      expect(strayErrors({ report: report(files), unhandled }), JSON.stringify(files)).toBe(
        undefined,
      );
    expect(strayErrors({ unhandled })).toBe(undefined);
    // Errors of the runner, its pool or a reporter are not the Worker's: the run failed.
    for (const type of [
      "Teardown Error",
      "Unhandled Error",
      "Unhandled Reporter Error",
      "Restart Error",
    ])
      expect(
        strayErrors({
          report: report([passedFile]),
          unhandled: JSON.stringify([stray, { type, message: "the pool broke" }]),
        }),
        type,
      ).toBe(undefined);
    expect(
      strayErrors({
        report: report([passedFile]),
        unhandled: JSON.stringify([{ type: "Uncaught Exception", message: "thrown in a timer" }]),
      }),
    ).toEqual([{ type: "Uncaught Exception", message: "thrown in a timer", times: 1 }]);
    expect(strayErrors({ report: report([passedFile]) })).toBe(undefined);
    expect(strayErrors({ report: report([passedFile]), unhandled: "[]" })).toBe(undefined);
  });
});
