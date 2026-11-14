import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { paxRecord, tarZst, zip } from "./archive.fixtures.ts";
import {
  ArchiveError,
  extractTarZst,
  extractZipEntries,
  flattenSingleDirectory,
} from "./archive.ts";

const root = mkdtempSync(join(tmpdir(), "eutaxy-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  return dir;
};
const mode = (path: string) => statSync(path).mode & 0o777;
/** A destination one level down, so an entry that escapes it lands in `outer`, which the test can look in. */
const nested = () => {
  const outer = fresh();
  const dest = join(outer, "dest");
  mkdirSync(dest);
  return { outer, dest };
};

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

  test("a link chain that leads out on disk is refused, and nothing is written through it", async () => {
    // `b -> a/..` stays inside on paper, but on disk `a` is followed first, so `b` is the parent.
    const through = join(root, "chain.tar.zst");
    writeFileSync(
      through,
      tarZst([
        { name: "a", type: "2", linkName: "." },
        { name: "b", type: "2", linkName: "a/.." },
        { name: "b/evil.txt", data: "escaped" },
      ]),
    );
    const one = nested();
    await expect(extractTarZst(through, one.dest)).rejects.toThrow(/goes through the link b/);
    expect(existsSync(join(one.outer, "evil.txt"))).toBe(false);
    // The same chain with no entry under it, and with its links in the other order.
    for (const order of [
      [
        { name: "a", type: "2", linkName: "." },
        { name: "b", type: "2", linkName: "a/.." },
      ],
      [
        { name: "b", type: "2", linkName: "a/.." },
        { name: "a", type: "2", linkName: "." },
      ],
    ]) {
      const file = join(root, "chain-only.tar.zst");
      writeFileSync(file, tarZst(order));
      await expect(extractTarZst(file, nested().dest)).rejects.toThrow(
        /link b points outside the toolchain directory/,
      );
    }
    // A hard link whose source goes through a link is refused too.
    const hard = join(root, "chain-hard.tar.zst");
    writeFileSync(
      hard,
      tarZst([
        { name: "a", type: "2", linkName: "." },
        { name: "b", type: "2", linkName: "a/.." },
        { name: "copy", type: "1", linkName: "b/secret" },
      ]),
    );
    await expect(extractTarZst(hard, nested().dest)).rejects.toThrow(/goes through the link b/);
    // And so is one whose source is itself such a link: copying it would read the parent's file.
    const one2 = nested();
    writeFileSync(join(one2.outer, "secret"), "SECRET");
    const named = join(root, "chain-hard-link.tar.zst");
    writeFileSync(
      named,
      tarZst([
        { name: "a", type: "2", linkName: "." },
        { name: "b", type: "2", linkName: "a/../secret" },
        { name: "copy", type: "1", linkName: "b" },
      ]),
    );
    await expect(extractTarZst(named, one2.dest)).rejects.toThrow(/names the link "b"/);
    expect(existsSync(join(one2.dest, "copy"))).toBe(false);
  });

  test("a file entry where a link already stands replaces the link instead of writing through it", async () => {
    const dest = fresh();
    const file = join(root, "replace.tar.zst");
    writeFileSync(
      file,
      tarZst([
        { name: "f", type: "2", linkName: "target" },
        { name: "f", data: "mine" },
      ]),
    );
    expect(await extractTarZst(file, dest)).toBe(2);
    expect(lstatSync(join(dest, "f")).isFile()).toBe(true);
    expect(readFileSync(join(dest, "f"), "utf8")).toBe("mine");
    expect(existsSync(join(dest, "target"))).toBe(false);
  });
});

describe("extractZipEntries", () => {
  const release = () =>
    zip([
      { name: "z3-1/", mode: 0o040755 },
      { name: "z3-1/bin/z3", data: "#!/bin/sh\necho z3\n", mode: 0o100755, deflate: true },
      { name: "z3-1/bin/libz3.dll", data: "dll", mode: 0o100644 },
      { name: "z3-1/README", data: "read me", mode: 0o100644 },
      { name: "z3-1/bin/z3-link", data: "z3", mode: 0o120777 },
      // A directory known only by its mode, without the trailing slash.
      { name: "z3-1/lib", mode: 0o040755 },
      { name: "../evil", data: "escaped" },
      { name: "a", data: ".", mode: 0o120777 },
      { name: "b", data: "a/..", mode: 0o120777 },
      { name: "b/evil.txt", data: "escaped" },
    ]);
  const write = (bytes: Buffer) => {
    const file = join(root, `entries-${n++}.zip`);
    writeFileSync(file, bytes);
    return file;
  };

  test("only the named files are written, at the paths given, as plain files; links and escaping entries elsewhere in the zip are never touched", () => {
    const { outer, dest } = nested();
    const file = write(release());
    expect(
      extractZipEntries(
        file,
        { "z3-1/bin/z3": "bin/z3", "z3-1/bin/libz3.dll": "bin/libz3.dll" },
        dest,
      ),
    ).toBe(2);
    expect(readFileSync(join(dest, "bin/z3"), "utf8")).toBe("#!/bin/sh\necho z3\n");
    expect(readFileSync(join(dest, "bin/libz3.dll"), "utf8")).toBe("dll");
    expect(mode(join(dest, "bin/z3"))).toBe(0o644);
    expect(readdirSync(dest, { recursive: true }).sort()).toEqual([
      "bin",
      join("bin", "libz3.dll"),
      join("bin", "z3"),
    ]);
    expect(readdirSync(outer)).toEqual(["dest"]);
  });

  test("a named entry that is missing, a link, a directory or there twice is refused, and nothing is written", () => {
    const file = write(release());
    for (const [entries, message] of [
      [
        { "z3-1/bin/z3": "bin/z3", "z3-1/bin/z3.exe": "bin/z3.exe" },
        /holds no "z3-1\/bin\/z3\.exe"/,
      ],
      [{ "z3-1/bin/z3-link": "bin/z3" }, /"z3-1\/bin\/z3-link" is a link, not a file/],
      [{ "z3-1/": "bin/z3" }, /"z3-1\/" is a directory, not a file/],
      [{ "z3-1/lib": "bin/z3" }, /"z3-1\/lib" is a directory, not a file/],
    ] as const) {
      const dest = fresh();
      expect(() => extractZipEntries(file, entries, dest)).toThrow(message);
      expect(readdirSync(dest)).toEqual([]);
    }
    const twice = write(
      zip([
        { name: "bin/z3", data: "one" },
        { name: "bin/z3", data: "two" },
      ]),
    );
    const dest = fresh();
    expect(() => extractZipEntries(twice, { "bin/z3": "bin/z3" }, dest)).toThrow(
      /"bin\/z3" is in the zip twice/,
    );
    expect(readdirSync(dest)).toEqual([]);
  });

  test("an entry whose data does not match its CRC-32 or its declared size is refused, and nothing is written", () => {
    for (const [entry, message] of [
      [{ name: "bin/z3", data: "solver", crc: 1234 }, /fails its CRC-32 check/],
      [{ name: "bin/z3", data: "solver", declaredSize: 3 }, /did not inflate to its declared size/],
      [
        { name: "bin/z3", data: "x".repeat(100_000), deflate: true, declaredSize: 10 },
        /did not inflate within its declared size/,
      ],
    ] as const) {
      const dest = fresh();
      expect(() => extractZipEntries(write(zip([entry])), { "bin/z3": "bin/z3" }, dest)).toThrow(
        message,
      );
      expect(readdirSync(dest)).toEqual([]);
    }
  });

  test("malformed zip64 records are refused as archive errors, not read past", () => {
    // An end record saying zip64, behind a locator that points past the end of the file.
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(1_000_000n, 8);
    locator.writeUInt32LE(1, 16);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    const pastEnd = write(Buffer.concat([locator, end]));
    expect(() => extractZipEntries(pastEnd, { "bin/z3": "bin/z3" }, fresh())).toThrow(
      /zip64 archive without its end record/,
    );
    // A zip64 extra field that says 8 bytes and holds 2.
    const field = Buffer.alloc(6);
    field.writeUInt16LE(0x0001, 0);
    field.writeUInt16LE(8, 2);
    const cut = write(
      zip([{ name: "bin/z3", data: "solver", declaredSize: 0xffffffff, extra: field }]),
    );
    expect(() => extractZipEntries(cut, { "bin/z3": "bin/z3" }, fresh())).toThrow(
      /extra field is cut short/,
    );
    // A zip64 field that holds fewer values than the entry needs.
    const short = Buffer.alloc(4);
    short.writeUInt16LE(0x0001, 0);
    const missing = write(
      zip([{ name: "bin/z3", data: "solver", declaredSize: 0xffffffff, extra: short }]),
    );
    expect(() => extractZipEntries(missing, { "bin/z3": "bin/z3" }, fresh())).toThrow(
      /zip64 field is cut short/,
    );
    for (const file of [pastEnd, cut, missing])
      expect(() => extractZipEntries(file, { "bin/z3": "bin/z3" }, fresh())).toThrow(ArchiveError);
  });

  test("a destination outside the directory is refused before the zip is read, and so is a file that is not a zip", () => {
    const file = write(release());
    for (const to of ["../z3", "", "."])
      expect(() => extractZipEntries(file, { "z3-1/bin/z3": to }, fresh())).toThrow(
        /is not a path under the toolchain directory/,
      );
    const not = write(Buffer.from("hello"));
    expect(() => extractZipEntries(not, { "bin/z3": "bin/z3" }, fresh())).toThrow(/not a zip file/);
  });

  test("an ArchiveError is what every refusal throws", () => {
    expect(() => extractZipEntries(write(release()), { nope: "x" }, fresh())).toThrow(ArchiveError);
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

  test("a link that led inside before the move up and leads outside after it is refused", () => {
    for (const [at, to] of [
      ["up", ".."],
      ["sub/up", "../../x"],
    ] as const) {
      const { dest } = nested();
      mkdirSync(join(dest, "top", "sub"), { recursive: true });
      symlinkSync(to, join(dest, "top", at));
      expect(() => flattenSingleDirectory(dest)).toThrow(/points outside the toolchain directory/);
    }
    const fine = fresh();
    mkdirSync(join(fine, "top", "lib"), { recursive: true });
    writeFileSync(join(fine, "top", "lib", "libfoo.so.1.2"), "");
    symlinkSync("libfoo.so.1.2", join(fine, "top", "lib", "libfoo.so.1"));
    symlinkSync("libfoo.so.1", join(fine, "top", "lib", "libfoo.so"));
    flattenSingleDirectory(fine);
    expect(readlinkSync(join(fine, "lib", "libfoo.so"))).toBe("libfoo.so.1");
  });
});
