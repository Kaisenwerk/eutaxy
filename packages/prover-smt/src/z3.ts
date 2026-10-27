/**
 * Running Z3 over a process boundary. The engine is pinned to one Z3
 * release: a `z3` on the PATH (or in Homebrew's and the usual local
 * prefixes) must report that version. Nothing is downloaded during a
 * check; a missing solver is `unavailable`, with how to install it. Every
 * run carries a resource limit, Z3's own machine-independent budget, so
 * the same script gives the same outcome on every machine; a wall-clock
 * timeout is only the safety net.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The Z3 release the engine's contract corpus is checked against. */
export const z3Version = "5.3.2";
/** How to put the pinned solver on this machine. */
export const installHint = `install Z3 ${z3Version} (https://github.com/Z3Prover/z3/releases/tag/z3-${z3Version}; Homebrew: brew install z3) so that z3 is on the PATH`;
/** The resource budget a check runs under (Z3's `rlimit`, in its own units), unless configured. */
export const defaultResourceLimit = 50_000_000;

export interface Z3Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface Z3Solver {
  readonly command: string;
  readonly version: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number },
): Promise<Z3Run> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Candidates for the `z3` executable: `EUTAXY_Z3`, the PATH, then the prefixes package managers install into. */
export function candidates(): string[] {
  const fromEnv = process.env["EUTAXY_Z3"];
  return [
    ...(fromEnv ? [fromEnv] : []),
    "z3",
    "/opt/homebrew/bin/z3",
    "/usr/local/bin/z3",
    "/usr/bin/z3",
  ];
}

/**
 * The pinned solver if it is installed: a `z3` of exactly that version,
 * wherever among the candidates it is; another version is reported only
 * when no candidate is the pinned one.
 */
export async function findZ3(
  where: readonly string[] = candidates(),
): Promise<Z3Solver | { readonly unavailable: string }> {
  let other: string | undefined;
  for (const z3 of where) {
    const v = await run(z3, ["--version"], { timeoutMs: 20_000 });
    if (v.code !== 0) continue;
    const m = /Z3 version (\S+)/.exec(v.stdout);
    if (m?.[1] === z3Version) return { command: z3, version: z3Version };
    other ??= m?.[1] ?? "of unknown version";
  }
  if (other !== undefined)
    return {
      unavailable: `z3 ${other} found, but the engine is pinned to ${z3Version}; ${installHint}`,
    };
  return { unavailable: `no z3 found; ${installHint}` };
}

export interface SolvedScript {
  readonly run: Z3Run;
  /** Whether Z3 reported the resource limit exceeded. */
  readonly resourceLimit: boolean;
}

/** Write the script to a scratch file and run Z3 on it under the resource limit. */
export async function solve(
  solver: Z3Solver,
  script: string,
  options: {
    readonly timeoutMs?: number;
    readonly resourceLimit?: number;
    readonly keep?: boolean;
  } = {},
): Promise<SolvedScript> {
  const dir = mkdtempSync(join(tmpdir(), "eutaxy-smt-"));
  try {
    const file = join(dir, "property.smt2");
    writeFileSync(file, script);
    const result = await run(
      solver.command,
      [`rlimit=${options.resourceLimit ?? defaultResourceLimit}`, "-smt2", file],
      { cwd: dir, timeoutMs: options.timeoutMs ?? 120_000 },
    );
    return { run: result, resourceLimit: /resource limit/i.test(result.stdout) };
  } finally {
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}
