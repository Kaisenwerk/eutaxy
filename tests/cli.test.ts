/** End to end: the eutaxy command runs a scenario in workerd through Vitest and reports. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

function eutaxy(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("eutaxy check", () => {
  test("reports a violation as JSON, writes the regression test, exits 1", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-cli-"));
    try {
      const outFile = join(out, "dup.regression.test.ts");
      const r = eutaxy([
        "check",
        "corpus/planted-bugs/queue-duplicate-write/scenario.sim.ts",
        "--json",
        "--seed",
        "cli",
        "--out",
        outFile,
      ]);
      expect(r.status, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout) as {
        schemaVersion: number;
        verdict: { kind: string; violation: { invariant: string } };
      };
      expect(report.schemaVersion).toBe(1);
      expect(report.verdict.kind).toBe("VIOLATED");
      expect(report.verdict.violation.invariant).toBe("payment-recorded-once");
      expect(existsSync(outFile)).toBe(true);
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain("holds on the recorded schedule");
      expect(src).toContain(
        "createCloudflarePlatform({ env, handler, schemas: { DB: schema_DB } })",
      );
      expect(existsSync(join(root, "corpus/planted-bugs/queue-duplicate-write/.eutaxy"))).toBe(
        false,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  test("reports BOUNDED as text and exits 0", () => {
    const r = eutaxy([
      "check",
      "corpus/differential/d1-ledger/scenario.sim.ts",
      "--max-runs",
      "3",
      "--seed",
      "cli",
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("BOUNDED  d1-ledger");
    expect(r.stdout).toContain("This is not a proof.");
  }, 180_000);

  test("fails clearly without a scenario or a wrangler config", () => {
    expect(eutaxy(["check"]).status).toBe(3);
    const bad = eutaxy([
      "check",
      "corpus/differential/d1-ledger/scenario.sim.ts",
      "--max-runs",
      "typo",
    ]);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain("--max-runs must be a positive integer");
    for (const budget of ["soon", "0", "-5"]) {
      const r = eutaxy([
        "check",
        "corpus/differential/d1-ledger/scenario.sim.ts",
        "--budget-ms",
        budget,
      ]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("--budget-ms must be a positive integer");
    }
    expect(
      eutaxy(["check", "corpus/differential/d1-ledger/scenario.sim.ts", "--max-runs", "0"]).status,
    ).toBe(3);
    expect(eutaxy(["check", "nope.sim.ts"]).status).toBe(3);
    expect(eutaxy(["nope"]).status).toBe(3);
    expect(eutaxy(["help"]).stdout).toContain("Usage:");
  });

  describe("specs", () => {
    const entry = "corpus/planted-bugs/refund-lost-update";
    interface SpecJson {
      kind: string;
      property: string;
      counterexample?: { call: string; binders: { name: string; value: string }[] };
    }

    test("observes the core: refines catches the lost update, the specs run the ladder", () => {
      const out = mkdtempSync(join(tmpdir(), "eutaxy-cli-"));
      try {
        const outFile = join(out, "refund.regression.test.ts");
        const r = eutaxy([
          "check",
          `${entry}/scenario.sim.ts`,
          "--json",
          "--seed",
          "corpus",
          "--out",
          outFile,
        ]);
        expect(r.status, r.stderr).toBe(1);
        const report = JSON.parse(r.stdout) as {
          verdict: { kind: string; violation: { invariant: string; keys: string[] } };
          specs: SpecJson[];
        };
        expect(report.verdict.kind).toBe("VIOLATED");
        expect(report.verdict.violation.keys[0]).toBe("stale_read");
        // The two sound properties hold on the simulator's inputs and on generated ones; the
        // off-by-one is found on a generated input, since the violation stopped the exploration
        // before the simulator reached one that shows it.
        expect(report.specs.map((s) => [s.property, s.kind])).toEqual([
          ["within-captured", "TESTED"],
          ["adds-the-amount", "TESTED"],
          ["full-refund-allowed", "REFUTED"],
        ]);
        const refuted = report.specs[2] as SpecJson & { rung: string };
        expect(refuted.rung).toBe("TESTED");
        expect(refuted.counterexample?.call).toBeUndefined();
        const [captured, refunded, amount] = (refuted.counterexample?.binders ?? []).map((b) =>
          Number(b.value),
        ) as [number, number, number];
        expect(refunded + amount).toBe(captured);
        expect(amount).toBeGreaterThan(0);
        // The regression test observes the core during its replay, so refines sees the decisions.
        expect(readFileSync(outFile, "utf8")).toContain('observeCore(core_0, ["decideRefund"])');
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }, 180_000);

    test("a property false on an input the simulator passed is REFUTED, and fails the check", () => {
      const r = eutaxy([
        "check",
        `${entry}/sequential.sim.ts`,
        "--seed",
        "corpus",
        "--no-regression",
      ]);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).toContain("BOUNDED  refund-lost-update");
      expect(r.stdout).toContain(
        "REFUTED  decideRefund full-refund-allowed: false at decideRefund(1000, 600, 400)",
      );
      expect(r.stdout).toContain("captured = 1000, refunded = 600, amount = 400");
    }, 180_000);

    test("a specs module that does not exist is an error, not a pass", () => {
      const path = join(root, entry, "missing-spec.tmp.sim.ts");
      writeFileSync(
        path,
        'import scenario from "./scenario.sim.ts";\nexport default { ...scenario, specs: ["./nope.ts"] };\n',
      );
      try {
        const r = eutaxy(["check", path, "--seed", "corpus", "--no-regression"]);
        expect(r.status).toBe(3);
        expect(r.stderr).toContain("./nope.ts: no such module next to the scenario");
      } finally {
        rmSync(path, { force: true });
      }
    }, 180_000);
  });
});
