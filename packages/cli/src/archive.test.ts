import {
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
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import { paxRecord, tar, tarGz, zip } from "./archive.fixtures.ts";
import { ArchiveError, extractTarGzEntries, extractZipEntries } from "./archive.ts";

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

describe("extractTarGzEntries", () => {
  const write = (bytes: Buffer) => {
    const file = join(root, `entries-${n++}.tar.gz`);
    writeFileSync(file, bytes);
    return file;
  };
  const release = () =>
    tarGz([
      { name: "elan-init", data: "#!/bin/sh\necho elan\n", mode: 0o755 },
      { name: "README", data: "read me" },
      { name: "dir/", type: "5", mode: 0o755 },
      { name: "link", type: "2", linkName: "/etc/passwd" },
      { name: "hard", type: "1", linkName: "elan-init" },
      { name: "../evil", data: "escaped" },
      { name: "a", type: "2", linkName: "." },
      { name: "b", type: "2", linkName: "a/.." },
      { name: "b/evil.txt", data: "escaped" },
    ]);

  test("only the named files are written, at the paths given, as plain files; links and escaping entries elsewhere in the tar are never touched", () => {
    const { outer, dest } = nested();
    expect(extractTarGzEntries(write(release()), { "elan-init": "bin/elan-init" }, dest)).toBe(1);
    expect(readFileSync(join(dest, "bin/elan-init"), "utf8")).toBe("#!/bin/sh\necho elan\n");
    expect(mode(join(dest, "bin/elan-init"))).toBe(0o644);
    expect(readdirSync(dest, { recursive: true }).sort()).toEqual([
      "bin",
      join("bin", "elan-init"),
    ]);
    expect(readdirSync(outer)).toEqual(["dest"]);
  });

  test("names given by a pax header or a GNU long name are the ones matched", () => {
    const long = `${"d/".repeat(60)}elan-init`;
    const pax = write(
      tarGz([
        { name: "PaxHeader", type: "x", data: paxRecord("path", long) },
        { name: "short-name", data: "from pax" },
      ]),
    );
    const dest = fresh();
    expect(extractTarGzEntries(pax, { [long]: "elan-init" }, dest)).toBe(1);
    expect(readFileSync(join(dest, "elan-init"), "utf8")).toBe("from pax");
    const gnu = write(
      tarGz([
        { name: "././@LongLink", type: "L", data: `${long}\0` },
        { name: "short-name", data: "from gnu" },
      ]),
    );
    const other = fresh();
    expect(extractTarGzEntries(gnu, { [long]: "elan-init" }, other)).toBe(1);
    expect(readFileSync(join(other, "elan-init"), "utf8")).toBe("from gnu");
    expect(() => extractTarGzEntries(gnu, { "short-name": "x" }, fresh())).toThrow(
      /holds no "short-name"/,
    );
  });

  test("a named entry that is missing, a link, a hard link, a directory or there twice is refused, and nothing is written", () => {
    const file = write(release());
    for (const [entries, message] of [
      [{ "elan-init": "a", "elan-init.exe": "b" }, /the tar holds no "elan-init\.exe"/],
      [{ link: "x" }, /"link" is a link, not a file/],
      [{ hard: "x" }, /"hard" is a link, not a file/],
      [{ "dir/": "x" }, /"dir\/" is a directory, not a file/],
    ] as const) {
      const dest = fresh();
      expect(() => extractTarGzEntries(file, entries, dest)).toThrow(message);
      expect(readdirSync(dest)).toEqual([]);
    }
    const twice = write(
      tarGz([
        { name: "elan-init", data: "one" },
        { name: "elan-init", data: "two" },
      ]),
    );
    expect(() => extractTarGzEntries(twice, { "elan-init": "x" }, fresh())).toThrow(
      /"elan-init" is in the tar twice/,
    );
  });

  test("a pax size that is not a plain number is refused, not looped on", () => {
    for (const size of ["-1536", "zz", "1e3"]) {
      const file = write(
        tarGz([
          { name: "PaxHeader", type: "x", data: paxRecord("size", size) },
          { name: "elan-init", data: "x" },
        ]),
      );
      expect(() => extractTarGzEntries(file, { "elan-init": "x" }, fresh())).toThrow(
        /a pax header gives the size/,
      );
    }
  });

  test("an old GNU header's time fields are not read as a name prefix", () => {
    const plain = tar([{ name: "elan-init", data: "old gnu" }]);
    const header = plain.subarray(0, 512);
    header.write("ustar  \0", 257, 8, "latin1");
    header.write("14715364562", 345, 11, "latin1");
    header.write("        ", 148, 8, "latin1");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    const dest = fresh();
    expect(extractTarGzEntries(write(gzipSync(plain)), { "elan-init": "x" }, dest)).toBe(1);
    expect(readFileSync(join(dest, "x"), "utf8")).toBe("old gnu");
  });

  test("a header that fails its checksum, a truncated tar and a file that is not gzip are refused as archive errors", () => {
    const plain = tar([{ name: "elan-init", data: "x".repeat(2000) }]);
    const corrupt = Buffer.from(plain);
    corrupt[10] = 0x41;
    expect(() =>
      extractTarGzEntries(write(gzipSync(corrupt)), { "elan-init": "x" }, fresh()),
    ).toThrow(/fails its checksum/);
    expect(() =>
      extractTarGzEntries(write(gzipSync(plain.subarray(0, 1024))), { "elan-init": "x" }, fresh()),
    ).toThrow(/truncated/);
    expect(() =>
      extractTarGzEntries(write(Buffer.from("hello")), { "elan-init": "x" }, fresh()),
    ).toThrow(ArchiveError);
    expect(() => extractTarGzEntries(write(release()), { "elan-init": "../x" }, fresh())).toThrow(
      /is not a path under the toolchain directory/,
    );
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
