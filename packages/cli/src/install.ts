/**
 * `eutaxy prover install <lean|smt>`: the pinned toolchain of a prover put
 * on this machine, where the engines look first.
 *
 * `installToolchain` installs a pinned upstream release file into Eutaxy's
 * cache: the file for this platform is downloaded (or copied from a mirror
 * or an offline directory given with `--from`), its SHA-256 checked against
 * the table before anything is unpacked, the files the table names taken
 * from it (a zip or a `tar.gz`) beside a marker written last, and the
 * download deleted. A mismatch or a failed download installs nothing, and
 * nothing is run. Z3 comes this way, and so does elan's installer.
 *
 * `installLean` installs Lean through elan, Lean's toolchain manager: the
 * machine's elan if it has one, else elan installed into Eutaxy's cache
 * from its pinned installer (without touching the PATH or the shell's
 * profile); then `elan toolchain install` of the pinned toolchain, whose
 * files' digest is checked against the pinned one, since elan checks no
 * pinned checksum itself.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  cacheDir,
  executableName,
  type Host,
  host,
  type InstallMarker,
  installed,
  markerFile,
  type Platform,
  platformOf,
  platforms,
  type Toolchain,
  toolchainDir,
} from "@eutaxy/prover/toolchain";
import {
  type Elan,
  elanCandidates,
  elanDownloads,
  elanHome,
  elanVersion,
  leanDigests,
  leanToolchain,
  leanVersion,
  toolchainDigest,
} from "@eutaxy/prover-lean";
import { z3Downloads } from "@eutaxy/prover-smt";
import { reportSchemaVersion } from "@eutaxy/report";
import { extractTarGzEntries, extractZipEntries } from "./archive.ts";
import { exitCodes } from "./check.ts";

/** The engines the command installs, by the name it takes. */
export const engines = ["lean", "smt"] as const;
export type Engine = (typeof engines)[number];

export class InstallError extends Error {}

export interface InstallOptions {
  readonly toolchain: Toolchain;
  readonly host?: Host;
  /** A mirror URL or a directory holding the release file under its upstream name. */
  readonly from?: string;
  /** How to download, for tests; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** Progress lines while a download runs. */
  readonly progress?: (text: string) => void;
}

export interface InstallResult {
  readonly name: string;
  readonly version: string;
  readonly platform: Platform;
  readonly file: string;
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly dir: string;
  readonly executable: string;
  /** False when the toolchain was already in the cache and nothing was downloaded. */
  readonly downloaded: boolean;
}

const isUrl = (s: string): boolean => /^https?:\/\//.test(s);

/** Write a byte stream to `path`, hashing it as it goes; the hash and the byte count come back. */
async function store(
  bytes: AsyncIterable<Uint8Array>,
  path: string,
  progress: ((written: number) => void) | undefined,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const fd = openSync(path, "w");
  let written = 0;
  let reported = 0;
  try {
    for await (const chunk of bytes) {
      writeSync(fd, chunk);
      hash.update(chunk);
      written += chunk.byteLength;
      if (progress && written - reported >= 50_000_000) {
        reported = written;
        progress(written);
      }
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes: written };
}

export async function installToolchain(options: InstallOptions): Promise<InstallResult> {
  const { toolchain } = options;
  const h = options.host ?? host();
  const platform = platformOf(h);
  const release = platform === undefined ? undefined : toolchain.files[platform];
  if (platform === undefined || release === undefined)
    throw new InstallError(
      `no ${toolchain.name} ${toolchain.version} release for ${h.platform}-${h.arch}; the platforms are ${platforms.join(", ")}`,
    );
  const cache = cacheDir(h);
  const dir = toolchainDir(cache, toolchain);
  const already = installed(toolchain, h);
  if (already)
    return {
      name: toolchain.name,
      version: toolchain.version,
      platform,
      file: already.marker.file,
      source: already.marker.source,
      sha256: already.marker.sha256,
      bytes: release.bytes,
      dir,
      executable: already.executable,
      downloaded: false,
    };
  const source =
    options.from === undefined
      ? release.url
      : isUrl(options.from)
        ? `${options.from.replace(/\/+$/, "")}/${release.file}`
        : join(options.from, release.file);
  // Staging paths of this invocation alone, so two installs sharing a cache never touch each other's files.
  const stamp = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const downloads = join(cache, "downloads");
  const archive = join(downloads, `${release.file}.${stamp}.part`);
  const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;
  try {
    mkdirSync(downloads, { recursive: true });
    let bytes: AsyncIterable<Uint8Array>;
    if (isUrl(source)) {
      const fetchImpl = options.fetch ?? fetch;
      let response: Response;
      try {
        response = await fetchImpl(source);
      } catch (err) {
        throw new InstallError(
          `could not download ${source}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!response.ok || response.body === null)
        throw new InstallError(
          `could not download ${source}: HTTP ${response.status} ${response.statusText}`,
        );
      options.progress?.(`downloading ${release.file} (${mb(release.bytes)}) from ${source}`);
      bytes = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    } else {
      if (!existsSync(source)) throw new InstallError(`no ${release.file} in ${options.from}`);
      bytes = createReadStream(source);
    }
    let stored: { sha256: string; bytes: number };
    try {
      stored = await store(bytes, archive, (n) =>
        options.progress?.(`${mb(n)} of ${mb(release.bytes)}`),
      );
    } catch (err) {
      throw new InstallError(
        `could not download ${source}: ${err instanceof Error ? err.message : String(err)}; nothing was installed`,
      );
    }
    if (stored.sha256 !== release.sha256)
      throw new InstallError(
        `checksum mismatch for ${release.file} from ${source}: expected sha256 ${release.sha256}, got ${stored.sha256} (${stored.bytes} bytes, ${release.bytes} expected); nothing was installed`,
      );
    const partial = `${dir}.partial-${stamp}`;
    mkdirSync(partial, { recursive: true });
    try {
      options.progress?.(`unpacking ${release.file}`);
      const extract = release.file.endsWith(".zip")
        ? extractZipEntries
        : release.file.endsWith(".tar.gz")
          ? extractTarGzEntries
          : undefined;
      if (extract === undefined)
        throw new InstallError(`${release.file} is neither a .zip nor a .tar.gz`);
      if (release.entries === undefined)
        throw new InstallError(
          `the table names no files to take from ${release.file}; nothing was installed`,
        );
      extract(archive, release.entries, partial);
      const executable = executableName(toolchain, h);
      if (!existsSync(join(partial, executable)))
        throw new InstallError(`${release.file} holds no ${executable}; nothing was installed`);
      // The named executable must run whatever mode the archive gave it (a zip made elsewhere carries none).
      if (h.platform !== "win32") chmodSync(join(partial, executable), 0o755);
      const marker: InstallMarker = {
        name: toolchain.name,
        version: toolchain.version,
        platform,
        file: release.file,
        sha256: stored.sha256,
        source,
      };
      writeFileSync(join(partial, markerFile), `${JSON.stringify(marker, null, 2)}\n`);
      rmSync(dir, { recursive: true, force: true });
      renameSync(partial, dir);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      throw err instanceof InstallError
        ? err
        : new InstallError(
            `could not unpack ${release.file}: ${err instanceof Error ? err.message : String(err)}; nothing was installed`,
          );
    }
    return {
      name: toolchain.name,
      version: toolchain.version,
      platform,
      file: release.file,
      source,
      sha256: stored.sha256,
      bytes: stored.bytes,
      dir,
      executable: join(dir, executableName(toolchain, h)),
      downloaded: true,
    };
  } catch (err) {
    // Anything but an install error here is the file system refusing (the cache not writable, say).
    throw err instanceof InstallError
      ? err
      : new InstallError(
          `could not install ${toolchain.name} ${toolchain.version} in ${cache}: ${err instanceof Error ? err.message : String(err)}`,
        );
  } finally {
    try {
      rmSync(archive, { force: true });
    } catch {
      // The download never got there (the cache is not a directory, say); the error above says why.
    }
  }
}

/** What running a command gave: its exit code (null when it could not start or timed out) and its output. */
export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}
export interface ExecOptions {
  /** Environment added to the process's own. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string;
  /** Killed after this long; a command that hangs never holds the install forever. */
  readonly timeoutMs?: number;
}
/** Run a command to its end; tests hand in another. */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** How long a quick elan command (a version, a list, a path) may take. */
const quickMs = 60_000;
/** How long elan may take to install the toolchain: a 600 MB download and 2.8 GB unpacked. */
const toolchainInstallMs = 60 * 60_000;

const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? quickMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        timedOut
          ? { code: null, stdout, stderr: `${stderr}timed out`, timedOut: true }
          : { code, stdout, stderr },
      );
    });
  });

/** The last lines of a command's error output, for a message. */
const tail = (text: string): string => text.trim().split("\n").slice(-5).join("\n");

export interface LeanInstallOptions {
  readonly host?: Host;
  /** Refused: Lean comes through elan, from its own host. */
  readonly from?: string;
  /** How to download elan's installer, for tests; the global `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  readonly progress?: (text: string) => void;
  /** How to run elan, for tests. */
  readonly exec?: Exec;
  /** The digests to check against, for tests; `leanDigests` otherwise. */
  readonly digests?: Readonly<Partial<Record<Platform, string>>>;
  /** The elan installer to fetch, for tests; `elanDownloads` otherwise. */
  readonly elanInstaller?: Toolchain;
}

/**
 * Lean through elan. The result's `file` is the toolchain's name, `source`
 * the elan that installed it, `sha256` the digest of the toolchain's files,
 * `bytes` their size and `dir` the toolchain's directory.
 */
export async function installLean(options: LeanInstallOptions = {}): Promise<InstallResult> {
  const h = options.host ?? host();
  const platform = platformOf(h);
  const expected = platform === undefined ? undefined : (options.digests ?? leanDigests)[platform];
  if (platform === undefined || expected === undefined)
    throw new InstallError(
      `no lean ${leanVersion} toolchain for ${h.platform}-${h.arch}; the platforms are ${platforms.join(", ")}`,
    );
  if (options.from !== undefined)
    throw new InstallError(
      `--from applies to smt only: Lean is installed by elan, which downloads it from releases.lean-lang.org; offline, unpack Lean's release by hand and register it with elan toolchain link`,
    );
  const run = options.exec ?? exec;
  const say = options.progress ?? (() => {});
  let elan: Elan | undefined;
  for (const candidate of elanCandidates(h)) {
    if ((await run(candidate.command, ["--version"], { env: candidate.env })).code === 0) {
      elan = candidate;
      break;
    }
  }
  if (elan === undefined) {
    const installer = await installToolchain({
      toolchain: options.elanInstaller ?? elanDownloads,
      host: h,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    });
    const home = elanHome(h);
    say(`installing elan ${elanVersion} in ${home}`);
    const made = await run(
      installer.executable,
      ["-y", "--no-modify-path", "--default-toolchain", "none"],
      { env: { ELAN_HOME: home }, timeoutMs: 10 * 60_000 },
    );
    elan = elanCandidates(h)[0] as Elan;
    if (made.code !== 0 || (await run(elan.command, ["--version"], { env: elan.env })).code !== 0)
      throw new InstallError(
        `elan's installer did not install elan in ${home} (exit ${made.code}): ${tail(made.stderr)}`,
      );
  }
  const list = await run(elan.command, ["toolchain", "list"], { env: elan.env });
  // Without the list it is unknown whether the toolchain was there, and so whether it is the
  // user's: stop rather than guess, since a mismatch would uninstall what this run installed.
  if (list.code !== 0)
    throw new InstallError(
      `elan (${elan.command}) could not list its toolchains (exit ${list.code}): ${tail(list.stderr)}`,
    );
  const had = list.stdout.split("\n").some((line) => line.trim().split(" ")[0] === leanToolchain);
  if (!had) {
    say(
      `installing ${leanToolchain} through ${elan.command} (about 600 MB to download, 2.8 GB unpacked)`,
    );
    const installed = await run(elan.command, ["toolchain", "install", leanToolchain], {
      env: elan.env,
      timeoutMs: toolchainInstallMs,
    });
    if (installed.code !== 0)
      throw new InstallError(
        `elan could not install ${leanToolchain} (exit ${installed.code}): ${tail(installed.stderr)}`,
      );
  }
  // Where it is, asked of elan without running anything from the toolchain, which is not checked
  // yet: `elan which` in a directory whose lean-toolchain file names it gives its `lean`'s path.
  const pinned = mkdtempSync(join(tmpdir(), "eutaxy-lean-toolchain-"));
  let where: ExecResult;
  try {
    writeFileSync(join(pinned, "lean-toolchain"), `${leanToolchain}\n`);
    // ELAN_TOOLCHAIN, if the caller set one, would win over the file: name the pinned one there too.
    where = await run(elan.command, ["which", "lean"], {
      env: { ...elan.env, ELAN_TOOLCHAIN: leanToolchain },
      cwd: pinned,
    });
  } finally {
    rmSync(pinned, { recursive: true, force: true });
  }
  const leanPath = where.stdout.trim();
  const prefix = dirname(dirname(leanPath));
  if (where.code !== 0 || !/[\\/]bin[\\/]lean(\.exe)?$/.test(leanPath) || !existsSync(prefix))
    throw new InstallError(
      `elan has ${leanToolchain} but did not say where (exit ${where.code}): ${tail(where.stderr) || leanPath}`,
    );
  say(`checking the files of ${leanToolchain} in ${prefix}`);
  const found = toolchainDigest(prefix);
  // An elan built for the other architecture of this system (x64 under Rosetta, say) installs the
  // pinned release for its own; that toolchain runs here too, so it is accepted, and said.
  const digests = options.digests ?? leanDigests;
  const sameSystem = Object.entries(digests).find(
    ([p, d]) => d === found.digest && p.startsWith(`${h.platform}-`),
  )?.[0];
  if (sameSystem !== undefined && sameSystem !== platform)
    say(
      `the toolchain is the pinned release for ${sameSystem}, the architecture ${elan.command} installs for, not ${platform}; it runs here too`,
    );
  if (sameSystem === undefined) {
    // Only a toolchain this run installed is removed; one that was already there is the user's.
    let fate = "it was there before this command, so it was left as it is";
    if (!had) {
      const removed = await run(elan.command, ["toolchain", "uninstall", leanToolchain], {
        env: elan.env,
      });
      fate =
        removed.code === 0
          ? "it was uninstalled"
          : `uninstalling it failed (exit ${removed.code}): remove it with elan toolchain uninstall ${leanToolchain}`;
    }
    throw new InstallError(
      `the toolchain in ${prefix} is not the pinned ${leanToolchain}: the digest of its files is ${found.digest}, expected ${expected}; ${fate}`,
    );
  }
  return {
    name: "lean",
    version: leanVersion,
    platform,
    file: leanToolchain,
    source: elan.command,
    sha256: found.digest,
    bytes: found.bytes,
    dir: prefix,
    executable: join(prefix, "bin", h.platform === "win32" ? "lean.exe" : "lean"),
    downloaded: !had,
  };
}

export interface RunInstallOptions {
  readonly engine: Engine;
  readonly from?: string | undefined;
  readonly json: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly host?: Host;
  readonly fetch?: typeof fetch;
  readonly exec?: Exec;
  readonly digests?: Readonly<Partial<Record<Platform, string>>>;
}

/** The command: the result as text or `--json` on stdout, progress and errors on stderr; exit 0, or 3 on an error. */
export async function runInstall(options: RunInstallOptions): Promise<number> {
  try {
    const shared = {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.from === undefined ? {} : { from: options.from }),
      progress: (text: string) => options.stderr(`${text}\n`),
    };
    const result =
      options.engine === "lean"
        ? await installLean({
            ...shared,
            ...(options.exec === undefined ? {} : { exec: options.exec }),
            ...(options.digests === undefined ? {} : { digests: options.digests }),
          })
        : await installToolchain({ ...shared, toolchain: z3Downloads });
    if (options.json) {
      options.stdout(
        `${JSON.stringify({ schemaVersion: reportSchemaVersion, command: "prover install", ...result }, null, 2)}\n`,
      );
    } else if (options.engine === "lean") {
      options.stdout(
        `${result.name} ${result.version} ${result.downloaded ? "installed" : "already installed"} in ${result.dir}\n  ${result.file} through ${result.source}\n  files checked, digest ${result.sha256}\n`,
      );
    } else if (result.downloaded) {
      options.stdout(
        `${result.name} ${result.version} installed in ${result.dir}\n  ${result.file} from ${result.source}\n  sha256 ${result.sha256}\n`,
      );
    } else {
      options.stdout(
        `${result.name} ${result.version} already installed in ${result.dir} (${result.file}, sha256 ${result.sha256})\n`,
      );
    }
    return exitCodes.BOUNDED;
  } catch (err) {
    if (!(err instanceof InstallError)) throw err;
    options.stderr(`${err.message}\n`);
    return exitCodes.error;
  }
}
