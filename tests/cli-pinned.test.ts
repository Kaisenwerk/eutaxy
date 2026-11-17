/**
 * End to end: `eutaxy check` runs the schedules a scenario pins before it explores, and reports a
 * pinned schedule's violation, named, with the regression test that replays its run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eutaxy } from "./eutaxy-command.ts";

const entry = "corpus/planted-bugs/workflow-fence-after-every-attempt/pinned.sim.ts";

describe("eutaxy check with pinned schedules", () => {
  test("replays the schedule pinned by step name and attempt, reports its violation by name, writes its test", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-pinned-"));
    try {
      const outFile = join(out, "pinned.regression.test.ts");
      const r = eutaxy([
        "check",
        entry,
        "--json",
        "--seed",
        "cli",
        "--max-runs",
        "1",
        "--out",
        outFile,
      ]);
      expect(r.status, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout) as {
        verdict: {
          kind: string;
          pinned: string;
          violation: { invariant: string };
          schedule: { seed: number; faults: { fault: string; target: string; op: string }[] };
          assumptions: string[];
        };
      };
      expect(report.verdict.kind).toBe("VIOLATED");
      expect(report.verdict.pinned).toBe("every attempt of start turn outlives its timeout");
      expect(report.verdict.violation.invariant).toBe("fenced-turns-never-run");
      expect(report.verdict.schedule.faults.map((f) => `${f.fault} ${f.target} ${f.op}`)).toEqual(
        Array(3).fill("ambiguous Workflow:TURNS step"),
      );
      expect(
        report.verdict.assumptions.some((a) =>
          a.startsWith("pinned schedules ran before exploration"),
        ),
      ).toBe(true);
      expect(existsSync(outFile)).toBe(true);
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain(
        `// The run of the scenario's pinned schedule "every attempt of start turn outlives its timeout" under seed ${report.verdict.schedule.seed}, as it ran.`,
      );
      expect(src).toContain("fenced-turns-never-run holds on the recorded schedule");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("eutaxy check on an UNSUPPORTED run", () => {
  test("writes a test that replays the run by its faults' calls, and exits 2", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-unsupported-"));
    try {
      const outFile = join(out, "replay.test.ts");
      const r = eutaxy([
        "check",
        "packages/eutaxy/workerd/unsupported-replay/scenario.sim.ts",
        "--json",
        "--seed",
        "corpus",
        "--out",
        outFile,
      ]);
      expect(r.status, r.stderr).toBe(2);
      const report = JSON.parse(r.stdout) as {
        regressionTest: string;
        verdict: { kind: string; cause: string; replay: { faults: { call: number }[] } };
      };
      expect(report.verdict.kind).toBe("UNSUPPORTED");
      expect(report.verdict.cause).toBe("unsupported_api");
      expect(report.verdict.replay.faults.map((f) => f.call)).toEqual([1]);
      expect(report.regressionTest).toMatch(/replay\.test\.ts$/);
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain('import { runPinned } from "eutaxy";');
      expect(src).toContain('"call":1');
      expect(src).not.toContain("invocation");
      expect(src).toContain("the recorded run still reaches what made the check UNSUPPORTED");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  test("writes nothing with --no-regression", () => {
    const r = eutaxy([
      "check",
      "packages/eutaxy/workerd/unsupported-replay/scenario.sim.ts",
      "--json",
      "--seed",
      "corpus",
      "--no-regression",
    ]);
    expect(r.status, r.stderr).toBe(2);
    expect((JSON.parse(r.stdout) as { regressionTest?: string }).regressionTest).toBeUndefined();
  }, 120_000);
});
