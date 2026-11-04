/**
 * The v0.14 gate, run through the command: `eutaxy check` builds the isolate
 * from both Workers' wrangler configs (the storefront's names the inventory
 * Worker by its real name and binds its stock class), runs both Workers'
 * real code, and the scenario is BOUNDED with nothing unsupported.
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

test("both Workers' real code, the stock object shared, the callee's Workflow: BOUNDED", () => {
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        bin,
        "check",
        "corpus/gates/v0-14-the-system/orders.sim.ts",
        "--json",
        "--seed",
        "gate",
        "--budget-ms",
        "30000",
        "--max-runs",
        "40",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  expect(status, stdout).toBe(0);
  const report = JSON.parse(stdout) as {
    verdict: { kind: string; assumptions: string[]; reached: { effectPoints: number } };
  };
  expect(report.verdict.kind).toBe("BOUNDED");
  expect(report.verdict.reached.effectPoints).toBeGreaterThan(100);
  expect(report.verdict.assumptions.join("\n")).toContain(
    "callee() setup runs that Worker's real code",
  );
}, 240_000);
