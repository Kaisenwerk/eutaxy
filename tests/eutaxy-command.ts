/** The eutaxy command as the end-to-end tests run it: the published bin, from the repository root. */
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

export interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `eutaxy check` gets a 30 s budget unless the test names one. A check's time budget is wall-clock:
 * on a slow runner the default would end exploration before the violating run and turn a VIOLATED
 * into a BOUNDED, so the run cap, not the clock, decides here.
 */
function budgeted(args: readonly string[]): readonly string[] {
  return args[0] === "check" && args.length > 1 && !args.includes("--budget-ms")
    ? [...args, "--budget-ms", "30000"]
    : args;
}

/** Run the command to completion, blocking: its exit status and what it printed. */
export function eutaxy(args: readonly string[], cwd: string = root): Ran {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...budgeted(args)], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** The same, without blocking, so a file's tests can run the command side by side. */
export function eutaxyAsync(args: readonly string[], cwd: string = root): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, ...budgeted(args)], {
      cwd,
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
