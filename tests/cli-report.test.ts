/** End to end: `eutaxy report` runs every spec file under a directory. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eutaxy, root } from "./eutaxy-command.ts";

describe("eutaxy report", () => {
  test("runs every spec file under a directory and exits 1 on a refutation", () => {
    const r = eutaxy(["report", "corpus/prover-contracts/shapes/refund-fixed"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("\n./domain.ts\n");
    expect(r.stdout).toContain("TESTED   decideRefund fullRefundAllowed: held on");
    expect(r.stdout).toContain("4 properties in 1 module:");
    expect(eutaxy(["report", "corpus/prover-contracts/constructs/strings", "extra"]).status).toBe(
      3,
    );
    // A forgotten value must not quietly drop the PROVEN rung; a check-only flag is not ignored.
    const bare = eutaxy(["report", "corpus/prover-contracts/constructs/strings", "--prover"]);
    expect(bare.status).toBe(3);
    expect(bare.stderr).toContain("--prover needs a value");
    const checkOnly = eutaxy([
      "report",
      "corpus/prover-contracts/constructs/strings",
      "--max-runs",
      "5",
    ]);
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
      "corpus/prover-contracts/shapes/refund-fixed",
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
