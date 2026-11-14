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
import { tarZst, zip } from "./archive.fixtures.ts";
import { InstallError, installToolchain, runInstall, toolchains } from "./install.ts";
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

const tarBytes = tarZst([
  { name: "tool-1.0/", type: "5", mode: 0o755 },
  { name: "tool-1.0/bin/tool", data: "#!/bin/sh\necho tool 1.0\n", mode: 0o755 },
  { name: "tool-1.0/lib/data.txt", data: "data", mode: 0o644 },
]);
const zipBytes = zip([
  { name: "tool-1.0/", mode: 0o040755 },
  { name: "tool-1.0/bin/tool", data: "#!/bin/sh\necho tool 1.0\n", mode: 0o100755, deflate: true },
  { name: "tool-1.0/README", data: "read me" },
]);
/** What the table takes from a zip release unless a test says otherwise. */
const toolEntries = { "tool-1.0/bin/tool": "bin/tool" };
/** `entries`: what the table takes from the release; `null` for none listed. */
const release = (
  file: string,
  bytes: Buffer,
  sha = sha256(bytes),
  entries?: Readonly<Record<string, string>> | null,
): Toolchain => {
  const listed =
    entries === null ? undefined : (entries ?? (file.endsWith(".zip") ? toolEntries : undefined));
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
  test("from an offline directory: the tree flattened, modes kept, the marker last, the archive gone; a second run installs nothing", async () => {
    const { cache, h } = fresh();
    const tool = release("tool-1.0-linux.tar.zst", tarBytes);
    const from = offline("tool-1.0-linux.tar.zst", tarBytes);
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
      file: "tool-1.0-linux.tar.zst",
      source: join(from, "tool-1.0-linux.tar.zst"),
      sha256: sha256(tarBytes),
      bytes: tarBytes.length,
      dir,
      executable: join(dir, "bin", "tool"),
      downloaded: true,
    });
    expect(readFileSync(join(dir, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho tool 1.0\n");
    expect(statSync(join(dir, "bin", "tool")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, "lib", "data.txt"), "utf8")).toBe("data");
    expect(JSON.parse(readFileSync(join(dir, markerFile), "utf8"))).toEqual({
      name: "tool",
      version: "1.0",
      platform,
      file: "tool-1.0-linux.tar.zst",
      sha256: sha256(tarBytes),
      source: join(from, "tool-1.0-linux.tar.zst"),
    });
    expect(readdirSync(join(cache, "downloads"))).toEqual([]);
    expect(progress).toEqual(["unpacking tool-1.0-linux.tar.zst"]);
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
    const tool = release("tool-1.0-linux.tar.zst", tarBytes, "0".repeat(64));
    const failure = installToolchain({
      toolchain: tool,
      host: h,
      from: offline("tool-1.0-linux.tar.zst", tarBytes),
    });
    await expect(failure).rejects.toBeInstanceOf(InstallError);
    await expect(failure).rejects.toThrow(
      /checksum mismatch for tool-1\.0-linux\.tar\.zst from .*: expected sha256 0{64}, got [0-9a-f]{64} \(\d+ bytes, \d+ expected\); nothing was installed/,
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
    const escaping = tarZst([
      { name: "../evil", data: "x" },
      { name: "tool-1.0/bin/tool", data: "x", mode: 0o755 },
    ]);
    await expect(
      installToolchain({
        toolchain: release("tool-1.0.tar.zst", escaping),
        host: c.h,
        fetch: serving(escaping),
      }),
    ).rejects.toThrow(
      /could not unpack tool-1\.0\.tar\.zst: entry "\.\.\/evil" would be written outside/,
    );
    expect(existsSync(join(c.cache, "toolchains", "tool", "1.0"))).toBe(false);
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
    const tool = release("tool-1.0-linux.tar.zst", tarBytes);
    const from = offline("tool-1.0-linux.tar.zst", tarBytes);
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

describe("runInstall and the command", () => {
  test("text and --json output; errors on stderr with exit 3", async () => {
    const { h } = fresh();
    const tool = release("tool-1.0-linux.tar.zst", tarBytes);
    const from = offline("tool-1.0-linux.tar.zst", tarBytes);
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };
    expect(await runInstall({ toolchain: tool, host: h, from, json: false, ...io })).toBe(0);
    expect(out).toMatch(
      /^tool 1\.0 installed in .*\n {2}tool-1\.0-linux\.tar\.zst from .*\n {2}sha256 [0-9a-f]{64}\n$/,
    );
    expect(err).toBe("unpacking tool-1.0-linux.tar.zst\n");
    out = "";
    expect(await runInstall({ toolchain: tool, host: h, from, json: true, ...io })).toBe(0);
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(json["schemaVersion"]).toBe(1);
    expect(json["command"]).toBe("prover install");
    expect(json["downloaded"]).toBe(false);
    out = "";
    err = "";
    const bad = release("tool-1.0-linux.tar.zst", tarBytes, "f".repeat(64));
    expect(await runInstall({ toolchain: bad, host: fresh().h, from, json: false, ...io })).toBe(3);
    expect(out).toBe("");
    expect(err).toMatch(/checksum mismatch/);
  });

  test("the command knows the two engines and refuses anything else", async () => {
    let out = "";
    let err = "";
    const io = { cwd: root, stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };
    expect(Object.keys(toolchains)).toEqual(["lean", "smt"]);
    expect(toolchains["lean"]?.executable).toBe("bin/lean");
    expect(toolchains["smt"]?.executable).toBe("bin/z3");
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
