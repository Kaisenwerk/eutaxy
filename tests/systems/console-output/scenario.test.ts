/**
 * `eutaxy check --console`, run through the command: a front Worker and
 * the Worker it calls both write to the console. Without the flag a check
 * shows none of it; with it, all of it on stderr, and stdout is the same.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

/** The command run to its end from the repository root: its exit status and its two streams, apart. */
function eutaxyAsync(
  args: readonly string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, ...args, "--budget-ms", "30000"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", fail);
    child.once("close", (status) => done({ status: status ?? 1, stdout, stderr }));
  });
}

const args = [
  "check",
  "tests/systems/console-output/notes.sim.ts",
  "--seed",
  "gate",
  "--max-runs",
  "2",
  "--no-regression",
];

/** The verdict's text without the line that says how long the check took. */
const verdict = (stdout: string): string =>
  stdout
    .split("\n")
    .filter((line) => !/\bms\b/.test(line) || line.startsWith("Bounds:"))
    .join("\n");

test("by default a check shows nothing the Workers wrote; with --console, all of it on stderr and the same verdict on stdout", async () => {
  const [quiet, shown] = await Promise.all([
    eutaxyAsync(args),
    eutaxyAsync([...args, "--console"]),
  ]);
  expect(quiet.status, quiet.stderr).toBe(0);
  expect(shown.status, shown.stderr).toBe(0);

  // Default: the verdict alone.
  expect(quiet.stdout).toMatch(/^BOUNDED {2}console-output {2}\(seed gate\)\n/);
  expect(quiet.stderr).toBe("");
  expect(quiet.stdout).not.toContain("front: note");

  // With the flag: the same verdict, and the Workers' lines on stderr, the callee's among them.
  expect(verdict(shown.stdout)).toBe(verdict(quiet.stdout));
  expect(shown.stdout).not.toContain("front: note");
  const lines = shown.stderr.split("\n");
  expect(lines[0]).toBe("Console output during the check, every run, as Vitest reported it:");
  // One run's lines, in the order the two Workers wrote them.
  expect(lines.slice(1, 6)).toEqual([
    "front: note n-1 received",
    "notes: recorded n-1",
    "front: note n-2 received",
    "notes: refused n-2: a note needs text",
    "front: note n-2 was refused",
  ]);
  // Every run of the check wrote the same five: the two explored and the two replayed before BOUNDED.
  expect(lines.filter((l) => l === "notes: refused n-2: a note needs text")).toHaveLength(4);
  expect(lines.filter((l) => l !== "")).toHaveLength(1 + 4 * 5);
}, 240_000);
