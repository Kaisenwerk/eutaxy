import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { paxRecord, tarZst, zip } from "./archive.fixtures.ts";
import { ArchiveError, extractTarZst, extractZip, flattenSingleDirectory } from "./archive.ts";

const root = mkdtempSync(join(tmpdir(), "eutaxy-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  return dir;
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe("extractTarZst", () => {
  test("files with their modes, directories, symlinks and hard links, read as the stream decompresses", async () => {
    const dest = fresh();
    const file = join(root, "a.tar.zst");
    writeFileSync(
      file,
      tarZst([
        { name: "tool-1.0/", type: "5", mode: 0o755 },
        { name: "tool-1.0/bin/", type: "5", mode: 0o755 },
        { name: "tool-1.0/bin/tool", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
        { name: "tool-1.0/lib/data.txt", data: "x".repeat(1500), mode: 0o644 },
        { name: "tool-1.0/lib/empty", data: "", mode: 0o600 },
        { name: "tool-1.0/bin/tool-link", type: "2", linkName: "tool" },
        { name: "tool-1.0/lib/copy.txt", type: "1", linkName: "tool-1.0/lib/data.txt" },
      ]),
    );
    expect(await extractTarZst(file, dest)).toBe(7);
    expect(readFileSync(join(dest, "tool-1.0/bin/tool"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(mode(join(dest, "tool-1.0/bin/tool"))).toBe(0o755);
    expect(readFileSync(join(dest, "tool-1.0/lib/data.txt"), "utf8")).toBe("x".repeat(1500));
    expect(mode(join(dest, "tool-1.0/lib/data.txt"))).toBe(0o644);
    expect(readFileSync(join(dest, "tool-1.0/lib/empty"), "utf8")).toBe("");
    expect(lstatSync(join(dest, "tool-1.0/bin/tool-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "tool-1.0/bin/tool-link"))).toBe("tool");
    expect(readFileSync(join(dest, "tool-1.0/lib/copy.txt"), "utf8")).toBe("x".repeat(1500));
  });

  test("pax and GNU long-name headers name the entry that follows; a ustar prefix is joined", async () => {
    const dest = fresh();
    const file = join(root, "b.tar.zst");
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    writeFileSync(
      file,
      tarZst([
        { name: "PaxHeader", type: "x", data: paxRecord("path", `pax/${long}`) },
        { name: "short", data: "pax" },
        { name: "././@LongLink", type: "L", data: `gnu/${long}\0` },
        { name: "short", data: "gnu" },
        { name: "plain.txt", data: "plain" },
      ]),
    );
    expect(await extractTarZst(file, dest)).toBe(3);
    expect(readFileSync(join(dest, "pax", long), "utf8")).toBe("pax");
    expect(readFileSync(join(dest, "gnu", long), "utf8")).toBe("gnu");
    expect(readFileSync(join(dest, "plain.txt"), "utf8")).toBe("plain");
  });

  test("an entry or link that would leave the directory is refused; a truncated stream is an error", async () => {
    const outside = join(root, "c.tar.zst");
    writeFileSync(outside, tarZst([{ name: "../evil", data: "x" }]));
    await expect(extractTarZst(outside, fresh())).rejects.toThrow(ArchiveError);
    const absolute = join(root, "d.tar.zst");
    writeFileSync(absolute, tarZst([{ name: "/etc/evil", data: "x" }]));
    await expect(extractTarZst(absolute, fresh())).rejects.toThrow(
      /outside the toolchain directory/,
    );
    const link = join(root, "e.tar.zst");
    writeFileSync(link, tarZst([{ name: "bin/tool", type: "2", linkName: "../../../bin/sh" }]));
    await expect(extractTarZst(link, fresh())).rejects.toThrow(/point outside/);
    const truncated = join(root, "f.tar.zst");
    const whole = tarZst([{ name: "big", data: "y".repeat(4000) }]);
    const { zstdDecompressSync, zstdCompressSync } = await import("node:zlib");
    writeFileSync(truncated, zstdCompressSync(zstdDecompressSync(whole).subarray(0, 1024)));
    await expect(extractTarZst(truncated, fresh())).rejects.toThrow(/truncated/);
  });
});

describe("extractZip", () => {
  test("stored and deflated entries, directories, Unix modes and symlinks", () => {
    const dest = fresh();
    const file = join(root, "a.zip");
    writeFileSync(
      file,
      zip([
        { name: "z3-1/", mode: 0o040755 },
        { name: "z3-1/bin/z3", data: "#!/bin/sh\necho z3\n", mode: 0o100755, deflate: true },
        { name: "z3-1/README", data: "read me", mode: 0o100644 },
        { name: "z3-1/bin/z3-link", data: "z3", mode: 0o120777 },
      ]),
    );
    expect(extractZip(file, dest)).toBe(4);
    expect(readFileSync(join(dest, "z3-1/bin/z3"), "utf8")).toBe("#!/bin/sh\necho z3\n");
    expect(mode(join(dest, "z3-1/bin/z3"))).toBe(0o755);
    expect(readFileSync(join(dest, "z3-1/README"), "utf8")).toBe("read me");
    expect(mode(join(dest, "z3-1/README"))).toBe(0o644);
    expect(readlinkSync(join(dest, "z3-1/bin/z3-link"))).toBe("z3");
  });

  test("an escaping entry is refused, and so is a file that is not a zip", () => {
    const file = join(root, "b.zip");
    writeFileSync(file, zip([{ name: "../evil", data: "x" }]));
    expect(() => extractZip(file, fresh())).toThrow(/outside the toolchain directory/);
    const not = join(root, "not.zip");
    writeFileSync(not, "hello");
    expect(() => extractZip(not, fresh())).toThrow(/not a zip file/);
  });
});

describe("flattenSingleDirectory", () => {
  test("one top-level directory is dropped; several entries stay as they are", () => {
    const one = fresh();
    mkdirSync(join(one, "tool-1.0", "bin"), { recursive: true });
    writeFileSync(join(one, "tool-1.0", "bin", "tool"), "");
    flattenSingleDirectory(one);
    expect(readFileSync(join(one, "bin", "tool"), "utf8")).toBe("");
    const several = fresh();
    mkdirSync(join(several, "bin"));
    writeFileSync(join(several, "README"), "");
    flattenSingleDirectory(several);
    expect(statSync(join(several, "bin")).isDirectory()).toBe(true);
  });
});
