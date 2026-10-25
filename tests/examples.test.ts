/** The examples double as acceptance tests: the eutaxy command must find the bug and clear the fix. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");
const example = join(root, "examples", "payments-queue");

function eutaxy(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd: example,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("examples/payments-queue", () => {
  test("the check finds the duplicate write and writes the regression test", () => {
    const regression = join(example, "payments.regression.test.ts");
    rmSync(regression, { force: true });
    try {
      // The run cap, not the runner's speed, ends exploration: seed "example" finds the bug in 9 runs.
      const r = eutaxy([
        "check",
        "./payments.sim.ts",
        "--seed",
        "example",
        "--max-runs",
        "50",
        "--budget-ms",
        "60000",
      ]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stdout).toContain("VIOLATED  payments");
      expect(r.stdout).toContain("Invariant payment-recorded-once is violated");
      expect(r.stdout).toContain("Regression test written to payments.regression.test.ts");
      expect(existsSync(regression)).toBe(true);
      // It replays under the budget the check ran with.
      expect(readFileSync(regression, "utf8")).toContain("budgetMs: 60000");
    } finally {
      rmSync(regression, { force: true });
    }
  }, 180_000);

  test("the fixed Worker is BOUNDED", () => {
    const r = eutaxy(["check", "./payments.fixed.sim.ts", "--seed", "example", "--max-runs", "30"]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("BOUNDED  payments-fixed");
    expect(r.stdout).toContain("This is not a proof.");
  }, 180_000);
});
