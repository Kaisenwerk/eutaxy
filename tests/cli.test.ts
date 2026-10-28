/** End to end: the eutaxy command runs a scenario in workerd through Vitest and reports. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

function eutaxy(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  // A check's time budget is wall-clock: on a slow runner the default would end exploration before the
  // violating run and turn a VIOLATED into a BOUNDED, so the run cap, not the clock, decides here.
  const withBudget =
    args[0] === "check" && args.length > 1 && !args.includes("--budget-ms")
      ? [...args, "--budget-ms", "30000"]
      : args;
  try {
    const stdout = execFileSync(process.execPath, [bin, ...withBudget], {
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
          ["withinCaptured", "TESTED"],
          ["addsTheAmount", "TESTED"],
          ["fullRefundAllowed", "REFUTED"],
          // Sampling with this seed reaches its 100 held inputs before it draws the NaN amount.
          ["totalNonNegative", "TESTED"],
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
        "REFUTED  decideRefund fullRefundAllowed: false at decideRefund(1000, 600, 400)",
      );
      expect(r.stdout).toContain("captured = 1000, refunded = 600, amount = 400");
    }, 180_000);

    test("--prover lean: the refund example's sound properties are PROVEN, the off-by-one stays REFUTED", () => {
      const probe = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { findLean } from "./packages/prover-lean/src/index.ts"; const t = await findLean(); process.stdout.write("unavailable" in t ? "no" : "yes");',
        ],
        { cwd: root, encoding: "utf8" },
      );
      const hasLean = probe.trim() === "yes";
      if (!hasLean && process.env["EUTAXY_REQUIRE_LEAN"] !== "1") return;
      expect(hasLean, "the pinned Lean toolchain is required here").toBe(true);
      const r = eutaxy([
        "check",
        `${entry}/sequential.sim.ts`,
        "--json",
        "--seed",
        "corpus",
        "--no-regression",
        "--prover",
        "lean",
      ]);
      expect(r.status, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout) as {
        specs: (SpecJson & { engine?: { name: string } })[];
      };
      expect(report.specs.map((s) => [s.property, s.kind])).toEqual([
        ["withinCaptured", "PROVEN"],
        ["addsTheAmount", "PROVEN"],
        ["fullRefundAllowed", "REFUTED"],
        // Under the integer model the claim holds, and sampling missed the NaN amount: PROVEN, misleadingly.
        ["totalNonNegative", "PROVEN"],
      ]);
      expect(report.specs[0]?.engine).toEqual({ name: "lean", version: "4.35.0" });
      const text = eutaxy([
        "check",
        `${entry}/sequential.sim.ts`,
        "--seed",
        "corpus",
        "--no-regression",
        "--prover",
        "lean",
      ]);
      expect(text.stdout).toContain(
        "PROVEN   decideRefund withinCaptured: by lean 4.35.0; also held on",
      );
      const z3 = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { findZ3 } from "./packages/prover-smt/src/index.ts"; const t = await findZ3(); process.stdout.write("unavailable" in t ? "no" : "yes");',
        ],
        { cwd: root, encoding: "utf8" },
      );
      const hasZ3 = z3.trim() === "yes";
      if (process.env["EUTAXY_REQUIRE_Z3"] === "1")
        expect(hasZ3, "the pinned Z3 is required here").toBe(true);
      if (hasZ3) {
        const both = eutaxy([
          "check",
          `${entry}/sequential.sim.ts`,
          "--json",
          "--seed",
          "corpus",
          "--no-regression",
          "--prover",
          "lean,smt",
        ]);
        expect(both.status, both.stderr).toBe(1);
        const two = JSON.parse(both.stdout) as {
          specs: (SpecJson & { engine?: { name: string } })[];
        };
        expect(two.specs.map((s) => [s.property, s.kind])).toEqual([
          ["withinCaptured", "PROVEN"],
          ["addsTheAmount", "PROVEN"],
          ["fullRefundAllowed", "REFUTED"],
          ["totalNonNegative", "CONFLICT"],
        ]);
        // The SMT engine's replayed NaN counterexample against the Lean engine's integer-model proof.
        const conflict = two.specs[3] as SpecJson & {
          proven: { name: string };
          refuted: { name: string; counterexample?: { binders: { value: string }[] } };
        };
        expect(conflict.proven.name).toBe("lean");
        expect(conflict.refuted.name).toBe("smt");
        expect(conflict.refuted.counterexample?.binders.map((b) => b.value)).toContain("NaN");
      }
      const unknown = eutaxy([
        "check",
        `${entry}/sequential.sim.ts`,
        "--seed",
        "corpus",
        "--no-regression",
        "--prover",
        "nope",
      ]);
      expect(unknown.status).toBe(3);
      expect(unknown.stderr).toContain("unknown prover nope");
    }, 300_000);

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

describe("eutaxy report", () => {
  test("runs every spec file under a directory and exits 1 on a refutation", () => {
    const r = eutaxy(["report", "corpus/prover-contracts/refund-fixed"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("\n./domain.ts\n");
    expect(r.stdout).toContain("TESTED   decideRefund fullRefundAllowed: held on");
    expect(r.stdout).toContain("4 properties in 1 module:");
    expect(eutaxy(["report", "corpus/prover-contracts/strings", "extra"]).status).toBe(3);
    // A check-only flag is not ignored.
    const checkOnly = eutaxy(["report", "corpus/prover-contracts/strings", "--max-runs", "5"]);
    expect(checkOnly.status).toBe(3);
    expect(checkOnly.stderr).toContain("report does not take --max-runs");
  });

  test("--json stays one JSON object when the user's modules write to stdout", () => {
    // Where `eutaxy/spec` resolves and no other test walks for spec files; .probe-* is gitignored.
    const dir = join(root, "corpus/planted-bugs", `.probe-report-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "domain.ts"),
        'console.log("domain loaded");\nexport function f(x: boolean): boolean {\n  process.stdout.write("f called\\n");\n  return x;\n}\n',
      );
      writeFileSync(
        join(dir, "domain.props.ts"),
        'import { forall } from "eutaxy/spec";\nimport { f } from "./domain.ts";\nexport const same = forall(f, { ensures: (x) => f(x) === x });\n',
      );
      const r = eutaxy(["report", dir, "--json"]);
      expect(r.status, r.stderr).toBe(0);
      const report = JSON.parse(r.stdout) as { specs: { kind: string }[] };
      expect(report.specs.map((s) => s.kind)).toEqual(["TESTED"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--prover smt: the PROVEN rung over the same specs, when Z3 is installed", () => {
    const z3 = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { findZ3 } from "./packages/prover-smt/src/index.ts"; const t = await findZ3(); process.stdout.write("unavailable" in t ? "no" : "yes");',
      ],
      { cwd: root, encoding: "utf8" },
    );
    const hasZ3 = z3.trim() === "yes";
    if (process.env["EUTAXY_REQUIRE_Z3"] === "1")
      expect(hasZ3, "the pinned Z3 is required here").toBe(true);
    if (!hasZ3) return;
    const r = eutaxy([
      "report",
      "corpus/prover-contracts/refund-fixed",
      "--prover",
      "smt",
      "--json",
    ]);
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout) as {
      specs: { property: string; kind: string; engine?: { name: string } }[];
    };
    // The manifest's expectations for the SMT engine, which the contract harness also holds it to.
    expect(report.specs.map((s) => [s.property, s.kind])).toEqual([
      ["withinCaptured", "REFUTED"],
      ["addsTheAmount", "REFUTED"],
      ["fullRefundAllowed", "PROVEN"],
      ["decideRefundTotal", "UNKNOWN"],
    ]);
    expect(report.specs[2]?.engine?.name).toBe("smt");
  }, 120_000);
});
