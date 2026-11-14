/**
 * Running Lean over a process boundary. The engine is pinned to one Lean
 * release, looked for through elan (Lean's toolchain manager), asked for it
 * by name: Eutaxy's own elan in its cache first (where `eutaxy prover
 * install lean` puts one when the machine has none), then the user's; then
 * as a bare `lean` that must report that version. Nothing is ever downloaded during
 * a check; a missing toolchain is `unavailable`, with the command that
 * installs it. Diagnostics come back as `file:line:col: severity: message`
 * lines, which the engine maps to theorems.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Host, host } from "@eutaxy/prover/toolchain";
import { type Elan, elanCandidates } from "./elan.ts";

/**
 * The Lean release the engine's contract corpus is checked against. On a
 * bump: run the corpus and the supplied-proof tests on the new release,
 * and read its release notes for a new command that runs code while a
 * file is checked (a `#` command is already refused; a new word goes into
 * `supplied.ts`'s refused list in the same change). CI caches the
 * toolchain by this file's hash.
 */
export const leanToolchain = "leanprover/lean4:v4.35.0";
export const leanVersion = "4.35.0";
/** How to put the pinned toolchain on this machine. */
export const installHint = `run: eutaxy prover install lean (or install elan, https://elan.lean-lang.org, and run: elan toolchain install ${leanToolchain})`;

export interface LeanRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface LeanDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

export interface LeanToolchain {
  /** The `lean` executable to run, with the arguments that select the pinned toolchain. */
  readonly command: string;
  readonly args: readonly string[];
  readonly version: string;
  /** Environment to add when running it (`ELAN_HOME` for Eutaxy's own elan). */
  readonly env?: Readonly<Record<string, string>>;
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs: number;
    readonly env?: Readonly<Record<string, string>> | undefined;
  },
): Promise<LeanRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a timeout kills `lean` under `elan run`, not just elan.
      child = spawn(command, args, {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
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

/** Candidates for a bare `lean`: the PATH, then elan's default home. */
function leanCandidates(h: Host): string[] {
  const home = h.env["ELAN_HOME"] || join(h.home || homedir(), ".elan");
  return ["lean", join(home, "bin", "lean")];
}

/**
 * The pinned toolchain if it is installed: through `elan run <toolchain>`
 * with the first elan that has it (Eutaxy's own, then the user's), else,
 * only when no elan answered at all, a bare `lean` of exactly that version.
 * Nothing is downloaded: an elan is run only for its toolchain list, and
 * with an elan present a bare `lean` would be its proxy.
 */
export async function findLean(
  h: Host = host(),
  elans: readonly Elan[] = elanCandidates(h),
  leans: readonly string[] = leanCandidates(h),
): Promise<LeanToolchain | { readonly unavailable: string }> {
  let lacking: string | undefined;
  for (const elan of elans) {
    const list = await run(elan.command, ["toolchain", "list"], {
      timeoutMs: 20_000,
      env: elan.env,
    });
    if (list.code !== 0) continue;
    if (list.stdout.split("\n").some((l) => l.trim().split(" ")[0] === leanToolchain))
      return {
        command: elan.command,
        args: ["run", leanToolchain, "lean"],
        version: leanVersion,
        ...(elan.env === undefined ? {} : { env: elan.env }),
      };
    lacking ??= `elan (${elan.command}) has no ${leanToolchain}`;
  }
  // With an elan on the machine a bare `lean` is most likely its proxy, which downloads whatever
  // toolchain it is asked for: never run it then, so a check downloads nothing.
  if (lacking !== undefined) return { unavailable: `${lacking}; ${installHint}` };
  for (const lean of leans) {
    const v = await run(lean, ["--version"], { timeoutMs: 20_000 });
    if (v.code !== 0) continue;
    const m = /Lean \(version ([^,]+),/.exec(v.stdout);
    if (m?.[1] === leanVersion) return { command: lean, args: [], version: leanVersion };
    return {
      unavailable: `lean ${m?.[1] ?? "of unknown version"} found, but the engine is pinned to ${leanVersion}; ${installHint}`,
    };
  }
  return { unavailable: `no Lean toolchain found; ${installHint}` };
}

/** Parse Lean's diagnostics for the one file it was given. */
/**
 * Lean's messages from `--json` output: one object per line, each with
 * its position. Lines that are not such an object (whatever a program
 * writes to the terminal) are not messages and are skipped, so nothing in
 * the checked file can pose as a message at a position it is not at.
 */
export function jsonDiagnostics(output: string): LeanDiagnostic[] {
  const out: LeanDiagnostic[] = [];
  for (const raw of output.split("\n")) {
    if (!raw.startsWith("{")) continue;
    let m: { pos?: { line?: unknown; column?: unknown }; severity?: unknown; data?: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      continue;
    }
    const severity =
      m.severity === "error"
        ? "error"
        : m.severity === "warning"
          ? "warning"
          : m.severity === "information"
            ? "info"
            : undefined;
    if (severity === undefined || typeof m.pos?.line !== "number" || typeof m.data !== "string")
      continue;
    out.push({
      line: m.pos.line,
      column: typeof m.pos.column === "number" ? m.pos.column : 0,
      severity,
      message: m.data.trimEnd(),
    });
  }
  return out;
}

export function diagnostics(output: string): LeanDiagnostic[] {
  const out: LeanDiagnostic[] = [];
  const re = /^(?:.*?):(\d+):(\d+): (error|warning|info): (.*)$/;
  let current:
    | { line: number; column: number; severity: LeanDiagnostic["severity"]; lines: string[] }
    | undefined;
  const flush = (c: NonNullable<typeof current>) =>
    out.push({
      line: c.line,
      column: c.column,
      severity: c.severity,
      message: c.lines.join("\n").trimEnd(),
    });
  for (const raw of output.split("\n")) {
    const m = re.exec(raw);
    if (m) {
      if (current) flush(current);
      current = {
        line: Number(m[1]),
        column: Number(m[2]),
        severity: m[3] as LeanDiagnostic["severity"],
        lines: [m[4] as string],
      };
    } else if (current) current.lines.push(raw);
  }
  if (current) flush(current);
  return out;
}

export interface CheckedFile {
  readonly run: LeanRun;
  readonly diagnostics: readonly LeanDiagnostic[];
}

/** Write the source to a scratch directory pinned to the toolchain and check it. */
export async function checkLean(
  toolchain: LeanToolchain,
  source: string,
  options: { readonly timeoutMs?: number; readonly keep?: boolean } = {},
): Promise<CheckedFile> {
  const dir = mkdtempSync(join(tmpdir(), "eutaxy-lean-"));
  try {
    writeFileSync(join(dir, "lean-toolchain"), `${leanToolchain}\n`);
    writeFileSync(join(dir, "Eutaxy.lean"), source);
    const result = await run(toolchain.command, [...toolchain.args, "--json", "Eutaxy.lean"], {
      cwd: dir,
      timeoutMs: options.timeoutMs ?? 120_000,
      env: toolchain.env,
    });
    return { run: result, diagnostics: jsonDiagnostics(`${result.stdout}\n${result.stderr}`) };
  } finally {
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}
