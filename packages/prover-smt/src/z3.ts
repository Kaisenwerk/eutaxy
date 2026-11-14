/**
 * Running Z3 over a process boundary. The engine is pinned to one Z3
 * release, looked for in Eutaxy's cache first (where `eutaxy prover install
 * smt` puts the upstream release named in `z3Downloads`), then as a `z3`
 * on the PATH (or in Homebrew's and the usual local prefixes) that must
 * report that version. Nothing is downloaded during a check; a missing
 * solver is `unavailable`, with how to install it. Every
 * run carries a resource limit, Z3's own machine-independent budget, so
 * the same script gives the same outcome on every machine; a wall-clock
 * timeout is only the safety net.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Host, host, installed, type Toolchain } from "@eutaxy/prover/toolchain";

/** The Z3 release the engine's contract corpus is checked against. */
export const z3Version = "5.3.2";
/** How to put the pinned solver on this machine. */
export const installHint = `run: eutaxy prover install smt (or put Z3 ${z3Version} on the PATH, from https://github.com/Z3Prover/z3/releases/tag/z3-${z3Version} or Homebrew: brew install z3)`;

const z3Release = `https://github.com/Z3Prover/z3/releases/download/z3-${z3Version}`;
/** The files the solver needs on Linux and macOS: the executable, which links only system libraries. */
const unixFiles = ["bin/z3"];
/**
 * On Windows the executable also needs the Visual C++ runtime, which a fresh
 * Windows may lack; the release ships it beside `z3.exe`, and Windows loads
 * a DLL from the executable's own directory first.
 */
const windowsFiles = [
  "bin/z3.exe",
  "bin/msvcp140.dll",
  "bin/vcruntime140.dll",
  "bin/vcruntime140_1.dll",
];
const z3File = (name: string, sha256: string, bytes: number, files: readonly string[]) => ({
  file: name,
  url: `${z3Release}/${name}`,
  sha256,
  bytes,
  // Each release puts everything under one directory named like the file.
  entries: Object.fromEntries(files.map((f) => [`${name.replace(/\.zip$/, "")}/${f}`, f])),
});
/**
 * The upstream release files `eutaxy prover install smt` downloads, one per
 * platform, as published on Z3's GitHub release with the checksums it
 * reports, and the files taken from each (the rest of the zip, bindings for
 * other languages, headers and the shared library, is not unpacked); the
 * file names carry the version, and a test holds them to `z3Version`. The
 * Linux builds need glibc 2.39 (x64) or 2.38 (arm64).
 */
export const z3Downloads: Toolchain = {
  name: "smt",
  version: z3Version,
  executable: "bin/z3",
  files: {
    "linux-x64": z3File(
      "z3-5.3.2-x64-glibc-2.39.zip",
      "26d463cddad3901cbf86e3868c784914539f4e3f9b4de1a0b8dc2969806d60e2",
      69479256,
      unixFiles,
    ),
    "linux-arm64": z3File(
      "z3-5.3.2-arm64-glibc-2.38.zip",
      "30b6a718a6cfe1b2db056038cc32eda5410f6d02e5937622b5238645347f59d5",
      64803341,
      unixFiles,
    ),
    "darwin-x64": z3File(
      "z3-5.3.2-x64-osx-13.3.zip",
      "b911dc193f7447a14fba001e8e8a0c2866a544274bb003e76a9e864f03b4d557",
      54270076,
      unixFiles,
    ),
    "darwin-arm64": z3File(
      "z3-5.3.2-arm64-osx-13.3.zip",
      "524290057c943a044ec3d1372db65a9c93f333d9817d58191154c4719ff7f8ad",
      53576249,
      unixFiles,
    ),
    "win32-x64": z3File(
      "z3-5.3.2-x64-win.zip",
      "a75aa2b0383a8ee355387a54daad796911d6a965076751eea18d21a27f38e983",
      70867398,
      windowsFiles,
    ),
  },
};
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

/**
 * Candidates for the `z3` executable: the one `eutaxy prover install smt`
 * put in the cache, `EUTAXY_Z3`, the PATH, then the prefixes package
 * managers install into.
 */
export function candidates(h: Host = host()): string[] {
  const fromEnv = h.env["EUTAXY_Z3"];
  const fromCache = installed(z3Downloads, h);
  return [
    ...(fromCache ? [fromCache.executable] : []),
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
