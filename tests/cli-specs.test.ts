/** End to end: `eutaxy check` runs the specs a scenario names, the ladder and the engines. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eutaxy, root } from "./eutaxy-command.ts";

describe("eutaxy check", () => {
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
          // False on a NaN amount, which TESTED tries before any random draw.
          ["totalNonNegative", "REFUTED"],
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
        // Lean proves it under the integer model; TESTED's NaN amount refutes it: neither wins.
        ["totalNonNegative", "CONFLICT"],
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
        // The NaN counterexample, found by TESTED before either engine ran, against Lean's
        // integer-model proof (the SMT engine refutes it too).
        const conflict = two.specs[3] as SpecJson & {
          proven: { name: string };
          refuted: {
            name: string;
            version: string;
            counterexample?: { binders: { value: string }[] };
          };
        };
        expect(conflict.proven.name).toBe("lean");
        expect(conflict.refuted).toMatchObject({ name: "simulator", version: "TESTED" });
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
