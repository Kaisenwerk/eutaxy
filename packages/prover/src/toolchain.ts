/**
 * Where a pinned prover toolchain lives on this machine once `eutaxy prover
 * install` has put it there, and what that command downloads: one upstream
 * release file per platform, with the checksum the download must match.
 * Node-side only (`@eutaxy/prover/toolchain`, a subpath so workerd never
 * loads it): it reads the file system, so this file alone references Node's
 * types, as the reader alone uses the compiler's. Nothing here downloads or
 * runs anything; the engines ask `installed` and the command does the rest.
 */
/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The platforms Eutaxy runs a prover on: Node's `process.platform-process.arch`. */
export type Platform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";
export const platforms: readonly Platform[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
];

/** One file of an upstream release: where it is, what it must hash to, how big it is. */
export interface ReleaseFile {
  /** The file's name in the release, which a mirror or offline copy keeps. */
  readonly file: string;
  readonly url: string;
  /** Lower-case hex SHA-256 of the file. */
  readonly sha256: string;
  readonly bytes: number;
  /**
   * For a zip, the files taken from it, each path in the archive mapped to
   * its path under the toolchain directory; nothing else in the zip is
   * unpacked. A zip must list them. A `tar.zst` is unpacked whole.
   */
  readonly entries?: Readonly<Record<string, string>>;
}

/** A prover toolchain as `eutaxy prover install` knows it. */
export interface Toolchain {
  /** The name the command takes: the engine's. */
  readonly name: string;
  readonly version: string;
  /** The executable inside the unpacked release, relative to its root; `.exe` is added on Windows. */
  readonly executable: string;
  readonly files: Readonly<Partial<Record<Platform, ReleaseFile>>>;
}

/** What of the machine the lookup depends on, so tests can hand in another. */
export interface Host {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export function host(): Host {
  return { platform: process.platform, arch: process.arch, env: process.env, home: homedir() };
}

export function platformOf(h: Host): Platform | undefined {
  const key = `${h.platform}-${h.arch}`;
  return (platforms as readonly string[]).includes(key) ? (key as Platform) : undefined;
}

/**
 * Eutaxy's cache directory: `EUTAXY_CACHE_DIR`, else the platform's user
 * cache (`$XDG_CACHE_HOME/eutaxy` or `~/.cache/eutaxy` on Linux,
 * `~/Library/Caches/eutaxy` on macOS, `%LOCALAPPDATA%\eutaxy\Cache` on
 * Windows). Always absolute: the engines spawn the executable from a
 * scratch directory, where a relative path would not resolve.
 */
export function cacheDir(h: Host = host()): string {
  const set = h.env["EUTAXY_CACHE_DIR"];
  if (set) return resolve(set);
  if (h.platform === "darwin") return join(h.home, "Library", "Caches", "eutaxy");
  if (h.platform === "win32")
    return join(h.env["LOCALAPPDATA"] || join(h.home, "AppData", "Local"), "eutaxy", "Cache");
  return resolve(h.env["XDG_CACHE_HOME"] || join(h.home, ".cache"), "eutaxy");
}

/** Where one toolchain's unpacked release lives: `<cache>/toolchains/<name>/<version>`. */
export function toolchainDir(
  cache: string,
  toolchain: Pick<Toolchain, "name" | "version">,
): string {
  return join(cache, "toolchains", toolchain.name, toolchain.version);
}

/** The file the command writes last, so its presence means the install completed. */
export const markerFile = "eutaxy-toolchain.json";

export interface InstallMarker {
  readonly name: string;
  readonly version: string;
  readonly platform: Platform;
  readonly file: string;
  readonly sha256: string;
  /** Where the file came from: the upstream URL, or the mirror or directory given. */
  readonly source: string;
}

export function executableName(toolchain: Pick<Toolchain, "executable">, h: Host): string {
  return h.platform === "win32" ? `${toolchain.executable}.exe` : toolchain.executable;
}

export interface Installed {
  readonly dir: string;
  readonly executable: string;
  readonly marker: InstallMarker;
}

/**
 * The toolchain the command put in the cache, if its marker and its
 * executable are both there and the marker names this toolchain for this
 * platform (a cache carried to another machine holds the wrong binary).
 */
export function installed(toolchain: Toolchain, h: Host = host()): Installed | undefined {
  const dir = toolchainDir(cacheDir(h), toolchain);
  const executable = join(dir, executableName(toolchain, h));
  const markerPath = join(dir, markerFile);
  if (!existsSync(markerPath) || !existsSync(executable)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<InstallMarker>;
    if (
      marker.name !== toolchain.name ||
      marker.version !== toolchain.version ||
      marker.platform !== platformOf(h) ||
      typeof marker.file !== "string" ||
      typeof marker.sha256 !== "string" ||
      typeof marker.source !== "string"
    )
      return undefined;
    return { dir, executable, marker: marker as InstallMarker };
  } catch {
    return undefined;
  }
}
