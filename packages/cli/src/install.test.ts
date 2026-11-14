import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host, markerFile, platformOf, type Toolchain } from "@eutaxy/prover/toolchain";
import { afterAll, describe, expect, test } from "vitest";
import { tarGz, zip } from "./archive.fixtures.ts";
import {
  type Exec,
  engines,
  InstallError,
  installLean,
  installToolchain,
  runInstall,
} from "./install.ts";
import { main } from "./main.ts";

const root = mkdtempSync(join(tmpdir(), "eutaxy-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A host whose cache is a fresh directory. */
const fresh = () => {
  const cache = join(root, `cache-${n++}`);
  return { cache, h: { ...host(), env: { EUTAXY_CACHE_DIR: cache } } };
};
const platform = platformOf(host());
if (platform === undefined) throw new Error("these tests run on a platform with a release");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const tarBytes = tarGz([
  { name: "tool-1.0/", type: "5", mode: 0o755 },
  { name: "tool-1.0/bin/tool", data: "#!/bin/sh\necho tool 1.0\n", mode: 0o755 },
  { name: "tool-1.0/lib/data.txt", data: "data", mode: 0o644 },
]);
const zipBytes = zip([
  { name: "tool-1.0/", mode: 0o040755 },
  { name: "tool-1.0/bin/tool", data: "#!/bin/sh\necho tool 1.0\n", mode: 0o100755, deflate: true },
  { name: "tool-1.0/README", data: "read me" },
]);
/** What the table takes from a release unless a test says otherwise. */
const toolEntries = { "tool-1.0/bin/tool": "bin/tool" };
/** `entries`: what the table takes from the release; `null` for none listed. */
const release = (
  file: string,
  bytes: Buffer,
  sha = sha256(bytes),
  entries?: Readonly<Record<string, string>> | null,
): Toolchain => {
  const listed = entries === null ? undefined : (entries ?? toolEntries);
  return {
    name: "tool",
    version: "1.0",
    executable: "bin/tool",
    files: {
      [platform]: {
        file,
        url: `https://example.invalid/releases/v1.0/${file}`,
        sha256: sha,
        bytes: bytes.length,
        ...(listed === undefined ? {} : { entries: listed }),
      },
    },
  };
};
const offline = (file: string, bytes: Buffer): string => {
  const dir = join(root, `offline-${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, file), bytes);
  return dir;
};
const fetched: string[] = [];
const serving =
  (bytes: Buffer | undefined): typeof fetch =>
  async (input) => {
    fetched.push(String(input));
    return bytes === undefined
      ? new Response(null, { status: 404, statusText: "Not Found" })
      : new Response(new Uint8Array(bytes));
  };

describe("installToolchain", () => {
  test("from an offline directory: the named files taken, the executable runnable, the marker last, the archive gone; a second run installs nothing", async () => {
    const { cache, h } = fresh();
    const tool = release("tool-1.0-linux.tar.gz", tarBytes);
    const from = offline("tool-1.0-linux.tar.gz", tarBytes);
    const progress: string[] = [];
    const result = await installToolchain({
      toolchain: tool,
      host: h,
      from,
      progress: (t) => progress.push(t),
    });
    const dir = join(cache, "toolchains", "tool", "1.0");
    expect(result).toEqual({
      name: "tool",
      version: "1.0",
      platform,
      file: "tool-1.0-linux.tar.gz",
      source: join(from, "tool-1.0-linux.tar.gz"),
      sha256: sha256(tarBytes),
      bytes: tarBytes.length,
      dir,
      executable: join(dir, "bin", "tool"),
      downloaded: true,
    });
    expect(readFileSync(join(dir, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho tool 1.0\n");
    expect(statSync(join(dir, "bin", "tool")).mode & 0o777).toBe(0o755);
    // Only what the table names is taken: the tar's other file stays in it.
    expect(existsSync(join(dir, "lib"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, markerFile), "utf8"))).toEqual({
      name: "tool",
      version: "1.0",
      platform,
      file: "tool-1.0-linux.tar.gz",
      sha256: sha256(tarBytes),
      source: join(from, "tool-1.0-linux.tar.gz"),
    });
    expect(readdirSync(join(cache, "downloads"))).toEqual([]);
    expect(progress).toEqual(["unpacking tool-1.0-linux.tar.gz"]);
    const again = await installToolchain({ toolchain: tool, host: h, fetch: serving(undefined) });
    expect(again).toEqual({ ...result, downloaded: false });
    expect(fetched).toEqual([]);
  });

  test("downloads from the upstream URL, or from a mirror that keeps the file name", async () => {
    const tool = release("tool-1.0.zip", zipBytes);
    const upstream = fresh();
    const progress: string[] = [];
    const result = await installToolchain({
      toolchain: tool,
      host: upstream.h,
      fetch: serving(zipBytes),
      progress: (t) => progress.push(t),
    });
    expect(fetched.splice(0)).toEqual(["https://example.invalid/releases/v1.0/tool-1.0.zip"]);
    expect(result.source).toBe("https://example.invalid/releases/v1.0/tool-1.0.zip");
    expect(statSync(result.executable).mode & 0o777).toBe(0o755);
    // Only what the table names is taken from a zip: the README stays in the archive.
    expect(readdirSync(result.dir, { recursive: true }).sort()).toEqual([
      "bin",
      join("bin", "tool"),
      markerFile,
    ]);
    expect(progress[0]).toMatch(/^downloading tool-1\.0\.zip \(0 MB\) from https:/);
    const mirrored = fresh();
    await installToolchain({
      toolchain: tool,
      host: mirrored.h,
      fetch: serving(zipBytes),
      from: "https://mirror.test/eutaxy/",
    });
    expect(fetched.splice(0)).toEqual(["https://mirror.test/eutaxy/tool-1.0.zip"]);
  });

  test("a checksum mismatch installs nothing and leaves no download behind", async () => {
    const { cache, h } = fresh();
    const tool = release("tool-1.0-linux.tar.gz", tarBytes, "0".repeat(64));
    const failure = installToolchain({
      toolchain: tool,
      host: h,
      from: offline("tool-1.0-linux.tar.gz", tarBytes),
    });
    await expect(failure).rejects.toBeInstanceOf(InstallError);
    await expect(failure).rejects.toThrow(
      /checksum mismatch for tool-1\.0-linux\.tar\.gz from .*: expected sha256 0{64}, got [0-9a-f]{64} \(\d+ bytes, \d+ expected\); nothing was installed/,
    );
    expect(existsSync(join(cache, "toolchains"))).toBe(false);
    expect(readdirSync(join(cache, "downloads"))).toEqual([]);
  });

  test("a failed download, a release without the executable, an escaping entry, an unknown platform: nothing installed", async () => {
    const tool = release("tool-1.0.zip", zipBytes);
    const a = fresh();
    await expect(
      installToolchain({ toolchain: tool, host: a.h, fetch: serving(undefined) }),
    ).rejects.toThrow(
      "could not download https://example.invalid/releases/v1.0/tool-1.0.zip: HTTP 404 Not Found",
    );
    expect(existsSync(join(a.cache, "toolchains"))).toBe(false);
    const b = fresh();
    const noExecutable = zip([{ name: "tool-1.0/README", data: "x" }]);
    await expect(
      installToolchain({
        toolchain: release("tool-1.0.zip", noExecutable),
        host: b.h,
        fetch: serving(noExecutable),
      }),
    ).rejects.toThrow(
      'could not unpack tool-1.0.zip: the zip holds no "tool-1.0/bin/tool"; nothing was installed',
    );
    expect(existsSync(join(b.cache, "toolchains", "tool", "1.0"))).toBe(false);
    const listsOther = fresh();
    await expect(
      installToolchain({
        toolchain: release("tool-1.0.zip", zipBytes, sha256(zipBytes), {
          "tool-1.0/README": "README",
        }),
        host: listsOther.h,
        fetch: serving(zipBytes),
      }),
    ).rejects.toThrow("tool-1.0.zip holds no bin/tool; nothing was installed");
    expect(existsSync(join(listsOther.cache, "toolchains", "tool", "1.0"))).toBe(false);
    const unlisted = fresh();
    await expect(
      installToolchain({
        toolchain: release("tool-1.0.zip", zipBytes, sha256(zipBytes), null),
        host: unlisted.h,
        fetch: serving(zipBytes),
      }),
    ).rejects.toThrow("the table names no files to take from tool-1.0.zip; nothing was installed");
    expect(existsSync(join(unlisted.cache, "toolchains", "tool", "1.0"))).toBe(false);
    expect(readdirSync(join(unlisted.cache, "downloads"))).toEqual([]);
    const c = fresh();
    const escaping = tarGz([
      { name: "../evil", data: "x" },
      { name: "tool-1.0/bin/tool", data: "x", mode: 0o755 },
    ]);
    // An escaping entry the table does not name is never read, let alone written.
    await installToolchain({
      toolchain: release("tool-1.0.tar.gz", escaping),
      host: c.h,
      fetch: serving(escaping),
    });
    expect(existsSync(join(c.cache, "toolchains", "tool", "1.0", "bin", "tool"))).toBe(true);
    expect(existsSync(join(c.cache, "toolchains", "evil"))).toBe(false);
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(fetched.splice(0)).toHaveLength(5);
    const d = fresh();
    await expect(
      installToolchain({
        toolchain: tool,
        host: { ...d.h, platform: "freebsd" },
        fetch: serving(zipBytes),
      }),
    ).rejects.toThrow(/no tool 1\.0 release for freebsd-/);
    expect(fetched.splice(0)).toEqual([]);
    const e = fresh();
    const failing: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(zipBytes.subarray(0, 10)));
            controller.error(new Error("connection reset"));
          },
        }),
      );
    await expect(installToolchain({ toolchain: tool, host: e.h, fetch: failing })).rejects.toThrow(
      /could not download https:\/\/example\.invalid\/releases\/v1\.0\/tool-1\.0\.zip: connection reset; nothing was installed/,
    );
    expect(existsSync(join(e.cache, "toolchains", "tool", "1.0"))).toBe(false);
    expect(readdirSync(join(e.cache, "downloads"))).toEqual([]);
    const f = fresh();
    writeFileSync(join(root, "a-file"), "not a directory");
    await expect(
      installToolchain({
        toolchain: tool,
        host: { ...f.h, env: { EUTAXY_CACHE_DIR: join(root, "a-file") } },
        fetch: serving(zipBytes),
      }),
    ).rejects.toThrow(/could not install tool 1\.0 in .*a-file: /);
  });

  test("two installs of one release into one cache, at once, both complete", async () => {
    const { h } = fresh();
    const tool = release("tool-1.0-linux.tar.gz", tarBytes);
    const from = offline("tool-1.0-linux.tar.gz", tarBytes);
    const [a, b] = await Promise.all([
      installToolchain({ toolchain: tool, host: h, from }),
      installToolchain({ toolchain: tool, host: h, from }),
    ]);
    expect(a.dir).toBe(b.dir);
    expect(readFileSync(join(a.dir, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho tool 1.0\n");
    expect(readdirSync(join(a.dir, ".."))).toEqual(["1.0"]);
    expect(readdirSync(join(a.dir, "..", "..", "..", "downloads"))).toEqual([]);
  });

  test("the named executable runs whatever mode the archive gave it", async () => {
    const { h } = fresh();
    const plainModes = zip([{ name: "tool-1.0/bin/tool", data: "#!/bin/sh\n", mode: 0o100644 }]);
    const result = await installToolchain({
      toolchain: release("tool-1.0.zip", plainModes),
      host: h,
      fetch: serving(plainModes),
    });
    expect(statSync(result.executable).mode & 0o777).toBe(0o755);
  });
});

/** A toolchain directory standing in for the one elan installs, and its digest. */
const fakeToolchain = async (): Promise<{ prefix: string; digest: string }> => {
  const { toolchainDigest } = await import("@eutaxy/prover-lean");
  const prefix = join(root, `toolchain-${n++}`);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "lean"), "lean");
  return { prefix, digest: toolchainDigest(prefix).digest };
};

/**
 * An elan as `installLean` sees it, through `exec`: which elans answer, which
 * toolchains each has, what each command did. `own` is the cache's elan.
 */
const fakeElans = (options: {
  readonly own: string;
  readonly present: readonly string[];
  readonly installed: Set<string>;
  readonly prefix: string;
  readonly installer?: string;
  /** An ELAN_TOOLCHAIN the caller's environment sets. */
  readonly override?: string;
}) => {
  const calls: string[] = [];
  const present = new Set(options.present);
  const exec: Exec = async (command, args, { env, cwd } = {}) => {
    const line = [command, ...args].join(" ");
    calls.push(env?.["ELAN_HOME"] === undefined ? line : `${line} [ELAN_HOME=${env["ELAN_HOME"]}]`);
    if (command === options.installer) {
      present.add(options.own);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (!present.has(command)) return { code: null, stdout: "", stderr: "not found" };
    const [a, b, c] = args;
    if (a === "--version") return { code: 0, stdout: "elan 4.2.4", stderr: "" };
    if (a === "toolchain" && b === "list")
      return { code: 0, stdout: [...options.installed].join("\n"), stderr: "" };
    if (a === "toolchain" && b === "install") {
      options.installed.add(c as string);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a === "toolchain" && b === "uninstall") {
      options.installed.delete(c as string);
      return { code: 0, stdout: "", stderr: "" };
    }
    // Nothing from the toolchain may run before its files are checked.
    if (a === "run") return { code: 99, stdout: "", stderr: "ran the unchecked toolchain" };
    if (a === "which" && b === "lean") {
      // elan prefers ELAN_TOOLCHAIN, from the caller's environment, over the lean-toolchain file.
      const fromEnv = env?.["ELAN_TOOLCHAIN"] || options.override || process.env["ELAN_TOOLCHAIN"];
      const pinned =
        fromEnv ||
        (cwd === undefined ? "" : readFileSync(join(cwd, "lean-toolchain"), "utf8").trim());
      return pinned === [...options.installed][0]
        ? { code: 0, stdout: `${join(options.prefix, "bin", "lean")}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: `no override for ${pinned}` };
    }
    return { code: 2, stdout: "", stderr: `unexpected: ${line}` };
  };
  return { exec, calls };
};

describe("installLean", () => {
  test("with the machine's elan: the toolchain installed through it, its files checked, nothing downloaded", async () => {
    const { leanToolchain } = await import("@eutaxy/prover-lean");
    fetched.splice(0);
    const { cache, h } = fresh();
    const { prefix, digest } = await fakeToolchain();
    const own = join(cache, "elan", "bin", "elan");
    const installed = new Set<string>();
    const elan = fakeElans({ own, present: ["elan"], installed, prefix });
    const progress: string[] = [];
    const result = await installLean({
      host: h,
      exec: elan.exec,
      digests: { [platform]: digest },
      fetch: serving(undefined),
      progress: (t) => progress.push(t),
    });
    expect(result).toMatchObject({
      name: "lean",
      file: leanToolchain,
      source: "elan",
      sha256: digest,
      dir: prefix,
      executable: join(prefix, "bin", "lean"),
      downloaded: true,
    });
    expect(elan.calls).toEqual([
      `${own} --version [ELAN_HOME=${join(cache, "elan")}]`,
      "elan --version",
      "elan toolchain list",
      `elan toolchain install ${leanToolchain}`,
      "elan which lean",
    ]);
    expect(fetched.splice(0)).toEqual([]);
    expect(progress[0]).toMatch(/^installing leanprover\/lean4:v[\d.]+ through elan/);
    // A second run finds it there and installs nothing.
    elan.calls.splice(0);
    const again = await installLean({ host: h, exec: elan.exec, digests: { [platform]: digest } });
    expect(again.downloaded).toBe(false);
    expect(elan.calls.some((c) => c.includes("toolchain install"))).toBe(false);
  });

  test("with no elan: the pinned installer fetched into the cache and run with the cache's ELAN_HOME, never touching the PATH", async () => {
    const { leanToolchain } = await import("@eutaxy/prover-lean");
    const { cache, h } = fresh();
    const { prefix, digest } = await fakeToolchain();
    const home = join(cache, "elan");
    const own = join(home, "bin", "elan");
    const initBytes = tarGz([{ name: "elan-init", data: "#!/bin/sh\n", mode: 0o755 }]);
    const elanInstaller: Toolchain = {
      name: "elan",
      version: "9.9",
      executable: "elan-init",
      files: {
        [platform]: {
          file: "elan-test.tar.gz",
          url: "https://example.invalid/elan/elan-test.tar.gz",
          sha256: sha256(initBytes),
          bytes: initBytes.length,
          entries: { "elan-init": "elan-init" },
        },
      },
    };
    const installer = join(cache, "toolchains", "elan", "9.9", "elan-init");
    const installed = new Set<string>();
    const elan = fakeElans({ own, present: [], installed, prefix, installer });
    const result = await installLean({
      host: h,
      exec: elan.exec,
      digests: { [platform]: digest },
      fetch: serving(initBytes),
      elanInstaller,
    });
    expect(fetched.splice(0)).toEqual(["https://example.invalid/elan/elan-test.tar.gz"]);
    expect(result.source).toBe(own);
    expect(elan.calls).toContain(
      `${installer} -y --no-modify-path --default-toolchain none [ELAN_HOME=${home}]`,
    );
    expect(elan.calls).toContain(`${own} toolchain install ${leanToolchain} [ELAN_HOME=${home}]`);
    expect(installed.has(leanToolchain)).toBe(true);
  });

  test("a toolchain whose files do not match the pinned digest is refused: uninstalled when this run installed it, left alone when it was there before", async () => {
    const { leanToolchain } = await import("@eutaxy/prover-lean");
    const { cache, h } = fresh();
    const { prefix } = await fakeToolchain();
    const own = join(cache, "elan", "bin", "elan");
    const installed = new Set<string>();
    const elan = fakeElans({ own, present: ["elan"], installed, prefix });
    const wrong = { [platform]: "0".repeat(64) };
    await expect(installLean({ host: h, exec: elan.exec, digests: wrong })).rejects.toThrow(
      /is not the pinned leanprover\/lean4:v[\d.]+: the digest of its files is [0-9a-f]{64}, expected 0{64}; it was uninstalled/,
    );
    expect(elan.calls).toContain(`elan toolchain uninstall ${leanToolchain}`);
    expect(installed.has(leanToolchain)).toBe(false);
    installed.add(leanToolchain);
    elan.calls.splice(0);
    await expect(installLean({ host: h, exec: elan.exec, digests: wrong })).rejects.toThrow(
      /it was there before this command, so it was left as it is/,
    );
    expect(elan.calls.some((c) => c.includes("uninstall"))).toBe(false);
    expect(installed.has(leanToolchain)).toBe(true);
  });

  test("an ELAN_TOOLCHAIN in the environment does not change which toolchain is located and checked", async () => {
    const { cache, h } = fresh();
    const { prefix, digest } = await fakeToolchain();
    const elan = fakeElans({
      own: join(cache, "elan", "bin", "elan"),
      present: ["elan"],
      installed: new Set(),
      prefix,
      override: "leanprover/lean4:v4.0.0",
    });
    const result = await installLean({ host: h, exec: elan.exec, digests: { [platform]: digest } });
    expect(result.dir).toBe(prefix);
  });

  test("an elan of the other architecture installs the pinned release for its own: accepted on the same system, refused for another", async () => {
    const { cache, h } = fresh();
    const { prefix, digest } = await fakeToolchain();
    const [os] = platform.split("-");
    const other =
      os === "win32" ? undefined : `${os}-${platform.endsWith("arm64") ? "x64" : "arm64"}`;
    const elan = () =>
      fakeElans({
        own: join(cache, "elan", "bin", "elan"),
        present: ["elan"],
        installed: new Set(),
        prefix,
      });
    const progress: string[] = [];
    if (other !== undefined) {
      const result = await installLean({
        host: h,
        exec: elan().exec,
        digests: { [platform]: "0".repeat(64), [other]: digest },
        progress: (t) => progress.push(t),
      });
      expect(result.sha256).toBe(digest);
      expect(progress.at(-1)).toContain(`the pinned release for ${other}`);
    }
    const foreign = os === "linux" ? "darwin-arm64" : "linux-x64";
    await expect(
      installLean({
        host: h,
        exec: elan().exec,
        digests: { [platform]: "0".repeat(64), [foreign]: digest },
      }),
    ).rejects.toThrow(/is not the pinned/);
  });

  test("an elan that cannot list its toolchains stops the install before anything is installed or removed", async () => {
    const { cache, h } = fresh();
    const { prefix } = await fakeToolchain();
    const elan = fakeElans({
      own: join(cache, "elan", "bin", "elan"),
      present: ["elan"],
      installed: new Set(),
      prefix,
    });
    const exec: Exec = async (command, args, options) =>
      args[0] === "toolchain" && args[1] === "list"
        ? { code: 1, stdout: "", stderr: "broken" }
        : elan.exec(command, args, options);
    await expect(
      installLean({ host: h, exec, digests: { [platform]: "0".repeat(64) } }),
    ).rejects.toThrow(/could not list its toolchains \(exit 1\): broken/);
    expect(elan.calls.some((c) => c.includes("install ") || c.includes("uninstall"))).toBe(false);
  });

  test("a failed uninstall after a mismatch is reported, not claimed done", async () => {
    const { cache, h } = fresh();
    const { prefix } = await fakeToolchain();
    const elan = fakeElans({
      own: join(cache, "elan", "bin", "elan"),
      present: ["elan"],
      installed: new Set(),
      prefix,
    });
    const exec: Exec = async (command, args, options) =>
      args[1] === "uninstall"
        ? { code: 4, stdout: "", stderr: "busy" }
        : elan.exec(command, args, options);
    await expect(
      installLean({ host: h, exec, digests: { [platform]: "0".repeat(64) } }),
    ).rejects.toThrow(/uninstalling it failed \(exit 4\): remove it with elan toolchain uninstall/);
  });

  test("--from is refused for Lean, before anything runs", async () => {
    const calls: string[] = [];
    const exec: Exec = async (command) => {
      calls.push(command);
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(installLean({ host: fresh().h, from: "/somewhere", exec })).rejects.toThrow(
      /--from applies to smt only/,
    );
    expect(calls).toEqual([]);
  });
});

describe("runInstall and the command", () => {
  test("text and --json output; errors on stderr with exit 3", async () => {
    const { leanToolchain } = await import("@eutaxy/prover-lean");
    const { cache, h } = fresh();
    const { prefix, digest } = await fakeToolchain();
    const elan = fakeElans({
      own: join(cache, "elan", "bin", "elan"),
      present: ["elan"],
      installed: new Set(),
      prefix,
    });
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };
    const lean = {
      engine: "lean",
      host: h,
      exec: elan.exec,
      digests: { [platform]: digest },
    } as const;
    expect(await runInstall({ ...lean, json: false, ...io })).toBe(0);
    expect(out).toBe(
      `lean ${leanToolchain.split(":v")[1]} installed in ${prefix}\n  ${leanToolchain} through elan\n  files checked, digest ${digest}\n`,
    );
    expect(err).toMatch(/^installing .* through elan .*\nchecking the files of /);
    out = "";
    expect(await runInstall({ ...lean, json: true, ...io })).toBe(0);
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json["schemaVersion"]).toBe(1);
    expect(json["command"]).toBe("prover install");
    expect(json["downloaded"]).toBe(false);
    out = "";
    err = "";
    // Z3 from a mirror that serves something else: the checksum refuses it.
    expect(
      await runInstall({
        engine: "smt",
        host: fresh().h,
        fetch: serving(Buffer.from("not z3")),
        from: "https://mirror.test/",
        json: false,
        ...io,
      }),
    ).toBe(3);
    expect(out).toBe("");
    expect(err).toMatch(/checksum mismatch/);
    fetched.splice(0);
  });

  test("the command knows the two engines and refuses anything else", async () => {
    let out = "";
    let err = "";
    const io = { cwd: root, stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };
    expect(engines).toEqual(["lean", "smt"]);
    expect(await main(["prover"], io)).toBe(3);
    expect(err).toContain("prover takes: install <lean|smt>");
    err = "";
    expect(await main(["prover", "install", "coq"], io)).toBe(3);
    expect(err).toBe("unknown engine coq; the engines are lean, smt\n");
    err = "";
    expect(await main(["prover", "install", "lean", "--seed", "x"], io)).toBe(3);
    expect(err).toBe("prover install does not take --seed\n");
    err = "";
    expect(await main(["prover", "install", "lean", "--from"], io)).toBe(3);
    expect(err).toBe("--from needs a value\n");
    expect(out).toBe("");
  });
});
