/**
 * Lean's toolchain comes through elan, Lean's own toolchain manager. This
 * file holds what `eutaxy prover install lean` and the engine share about
 * it: the pinned elan installer (`elanDownloads`, fetched only when no elan
 * is on the machine), where Eutaxy keeps an elan of its own (`elanHome`,
 * inside Eutaxy's cache), the elans the engine and the command look for
 * (`elanCandidates`), and the digest of the pinned toolchain's files
 * (`leanDigests`, `toolchainDigest`), which the command checks after elan
 * has installed it, since elan does not check the toolchain it downloads
 * against a pinned checksum.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { cacheDir, type Host, type Platform, type Toolchain } from "@eutaxy/prover/toolchain";

/** The elan release whose installer the command fetches when the machine has no elan. */
export const elanVersion = "4.2.4";

const elanRelease = `https://github.com/leanprover/elan/releases/download/v${elanVersion}`;
const elanFile = (name: string, sha256: string, bytes: number) => {
  // Each archive holds the one installer, at its root.
  const installer = name.endsWith(".zip") ? "elan-init.exe" : "elan-init";
  return {
    file: name,
    url: `${elanRelease}/${name}`,
    sha256,
    bytes,
    entries: { [installer]: installer },
  };
};
/**
 * The upstream elan installer for each platform, as published on elan's
 * GitHub release with the checksums it reports; a test holds the file
 * names to `elanVersion`. The installer links only system libraries.
 */
export const elanDownloads: Toolchain = {
  name: "elan",
  version: elanVersion,
  executable: "elan-init",
  files: {
    "linux-x64": elanFile(
      "elan-x86_64-unknown-linux-gnu.tar.gz",
      "42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63",
      4996571,
    ),
    "linux-arm64": elanFile(
      "elan-aarch64-unknown-linux-gnu.tar.gz",
      "05febd124d84ebf994b2e7479922a5650b1e950c17ae3bd1ddd776b65bb72bf9",
      5131114,
    ),
    "darwin-x64": elanFile(
      "elan-x86_64-apple-darwin.tar.gz",
      "8a340b309d8ed2e96f930761fa223b3af57a38f5d253b53ac90293c9516f8cd4",
      2330818,
    ),
    "darwin-arm64": elanFile(
      "elan-aarch64-apple-darwin.tar.gz",
      "7ad829861392c718dfebde3a83b5c8508df47be02af68894b094b0b3952616e5",
      2190845,
    ),
    "win32-x64": elanFile(
      "elan-x86_64-pc-windows-msvc.zip",
      "fad2e980a191c15884cc1d80d170ffc5fa84f3774541020145b66d1a644c6111",
      2508099,
    ),
  },
};

/** Where Eutaxy's own elan keeps itself and its toolchains: `<cache>/elan`. */
export function elanHome(h: Host): string {
  return join(cacheDir(h), "elan");
}

/** An elan to run, with the environment it needs (`ELAN_HOME` for Eutaxy's own). */
export interface Elan {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The elans to try, in order: Eutaxy's own in the cache, then the one on
 * the PATH, then the one in elan's home (`ELAN_HOME`, else `~/.elan`).
 */
export function elanCandidates(h: Host): Elan[] {
  const exe = h.platform === "win32" ? "elan.exe" : "elan";
  const own = elanHome(h);
  const home = h.env["ELAN_HOME"] || join(h.home || homedir(), ".elan");
  return [
    { command: join(own, "bin", exe), env: { ELAN_HOME: own } },
    { command: "elan" },
    { command: join(home, "bin", exe) },
  ];
}

/**
 * The pinned toolchain's `toolchainDigest`, per platform: computed over
 * Lean's GitHub release file for that platform, checked against the
 * checksum the release reports, and unpacked. elan installs exactly that
 * release (on macOS arm64 the digest of an elan-installed toolchain was
 * checked to equal it), so a toolchain elan installed whose digest differs
 * is not the pinned one.
 */
export const leanDigests: Readonly<Record<Platform, string>> = {
  "linux-x64": "d6bb6c4de1fce52bc5d88ff52f7fcf7d347ee5b3ba7d187de775ccf915714c35",
  "linux-arm64": "1bcaf2cf93006e3017a07234e3a33ba8bd1dec404e7dc0e4c202111b0bf2be41",
  "darwin-x64": "b817cf3c90432b774405bad998bad5985f0ef9594d1c31aeddb3df6479c1bd0c",
  "darwin-arm64": "2a31778d0185a17655be5f97e6e930dd0ece0d1db9f41a2825f500b3ca8c5c0a",
  "win32-x64": "441877e59afc80b7af1f1b6fc3db64b2c947d581de26a040486387aa4ec7a3cb",
};

export interface ToolchainDigest {
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
}

/**
 * A digest of everything under a toolchain's directory: one line per file
 * (`<sha256>  <path>`) and per link (`-> <target>  <path>`), paths relative
 * and with `/`, sorted, the whole hashed. Directories count only through
 * what they hold.
 */
export function toolchainDigest(prefix: string): ToolchainDigest {
  const lines: (readonly [string, string])[] = [];
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(prefix, { recursive: true, withFileTypes: true })) {
    const at = join(entry.parentPath, entry.name);
    const path = relative(prefix, at).split(sep).join("/");
    if (entry.isSymbolicLink()) lines.push([path, `-> ${readlinkSync(at)}  ${path}`]);
    else if (entry.isFile()) {
      const data = readFileSync(at);
      files++;
      bytes += data.length;
      lines.push([path, `${createHash("sha256").update(data).digest("hex")}  ${path}`]);
    }
  }
  lines.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    digest: createHash("sha256")
      .update(`${lines.map(([, line]) => line).join("\n")}\n`)
      .digest("hex"),
    files,
    bytes,
  };
}
