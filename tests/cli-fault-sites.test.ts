/**
 * End to end: a scenario whose bounds say where faults go is checked by `eutaxy check` with its
 * faults only there. The planted bug needs a fault on each of three attempts of one step, which
 * sampling over every point does not reach (its own corpus test asserts that).
 */
import { describe, expect, test } from "vitest";
import { eutaxy } from "./eutaxy-command.ts";

const entry = "corpus/planted-bugs/workflow-fence-after-every-attempt/scenario.sim.ts";

describe("eutaxy check with fault sites", () => {
  test("finds the violation that needs a fault on every attempt of one step, faults on that step alone, and says so", () => {
    const r = eutaxy([
      "check",
      entry,
      "--json",
      "--exhaustive",
      "--seed",
      "cli",
      "--no-regression",
    ]);
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout) as {
      verdict: {
        kind: string;
        violation: { invariant: string };
        schedule: { faults: { fault: string; target: string; op: string }[] };
        assumptions: string[];
      };
    };
    expect(report.verdict.kind).toBe("VIOLATED");
    expect(report.verdict.violation.invariant).toBe("fenced-turns-never-run");
    const faults = report.verdict.schedule.faults;
    expect(faults).toHaveLength(3);
    for (const f of faults)
      expect(`${f.target} ${f.op}`).toMatch(/^Workflow:TURNS step(_result)?$/);
    expect(faults.at(-1)?.fault).toBe("ambiguous");
    expect(report.verdict.assumptions).toContain(
      'faults only where the scenario\'s bounds say: any fault at Workflow:TURNS where {"args.step":"start turn"}; redelivery per the platform\'s queue model',
    );
  }, 120_000);
});
