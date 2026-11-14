/**
 * `eutaxy prover install <name>`: the pinned release of a prover put in
 * Eutaxy's cache, where the engines look first. The file for this platform
 * is downloaded (or copied from a mirror or an offline directory given with
 * `--from`), its SHA-256 checked against the engine's table before anything
 * is unpacked, unpacked beside a marker written last (a `tar.zst` whole, a
 * zip only for the files the table names, at the paths it gives), and
 * deleted. A
 * mismatch or a failed download installs nothing. Nothing is run: the
 * engines check the version when they look the toolchain up.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
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
import { leanDownloads } from "@eutaxy/prover-lean";
import { z3Downloads } from "@eutaxy/prover-smt";
import { reportSchemaVersion } from "@eutaxy/report";
import { extractTarZst, extractZipEntries, flattenSingleDirectory } from "./archive.ts";
import { exitCodes } from "./check.ts";

/** The toolchains the command installs, by the engine name it takes. */
export const toolchains: Readonly<Record<string, Toolchain>> = {
  lean: leanDownloads,
  smt: z3Downloads,
};

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
      if (release.file.endsWith(".zip")) {
        if (release.entries === undefined)
          throw new InstallError(
            `the table names no files to take from ${release.file}; nothing was installed`,
          );
        extractZipEntries(archive, release.entries, partial);
      } else if (release.file.endsWith(".tar.zst")) {
        await extractTarZst(archive, partial);
        flattenSingleDirectory(partial);
      } else throw new InstallError(`${release.file} is neither a .zip nor a .tar.zst`);
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

export interface RunInstallOptions {
  readonly toolchain: Toolchain;
  readonly from?: string | undefined;
  readonly json: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly host?: Host;
  readonly fetch?: typeof fetch;
}

/** The command: the result as text or `--json` on stdout, progress and errors on stderr; exit 0, or 3 on an error. */
export async function runInstall(options: RunInstallOptions): Promise<number> {
  try {
    const result = await installToolchain({
      toolchain: options.toolchain,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.from === undefined ? {} : { from: options.from }),
      progress: (text) => options.stderr(`${text}\n`),
    });
    if (options.json) {
      options.stdout(
        `${JSON.stringify({ schemaVersion: reportSchemaVersion, command: "prover install", ...result }, null, 2)}\n`,
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
