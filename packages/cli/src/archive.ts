/**
 * Reading the two archive formats the release files come in, with Node's
 * standard library alone: a zip (Z3; elan's installer on Windows) and a
 * gzip-compressed tar (elan's installer elsewhere). From either, only the
 * files the caller names are taken, each to the path the caller gives: the
 * archive chooses no path and makes no link, so nothing in it can write
 * anywhere else. A named entry that is missing, there twice, a link or a
 * directory, or whose data does not match what its headers say, is refused,
 * and nothing is written until every named entry has been read.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";

export class ArchiveError extends Error {}

const inside = (dest: string, path: string): boolean =>
  path === dest || path.startsWith(dest + sep);

/** Each named entry's place under `dest`, checked before the archive is read. */
function placesOf(entries: Readonly<Record<string, string>>, dest: string): Map<string, string> {
  const root = resolve(dest);
  const places = new Map<string, string>();
  for (const [name, to] of Object.entries(entries)) {
    const place = resolve(root, to);
    if (place === root || !inside(root, place))
      throw new ArchiveError(`${JSON.stringify(to)} is not a path under the toolchain directory`);
    places.set(name, place);
  }
  return places;
}

/**
 * Write what was read, once every named entry has been: files with mode
 * 0644 (the caller makes its executable runnable). Returns how many.
 */
function writeFound(
  kind: string,
  places: ReadonlyMap<string, string>,
  found: ReadonlyMap<string, Buffer>,
): number {
  const missing = [...places.keys()].filter((name) => !found.has(name));
  if (missing.length > 0)
    throw new ArchiveError(
      `the ${kind} holds no ${missing.map((m) => JSON.stringify(m)).join(", ")}`,
    );
  for (const [name, data] of found) {
    const place = places.get(name) as string;
    mkdirSync(dirname(place), { recursive: true });
    writeFileSync(place, data, { mode: 0o644 });
  }
  return found.size;
}

const ZIP_EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

/** The central directory's position and entry count, through the zip64 records when the plain ones overflow. */
function centralDirectory(zip: Buffer): { offset: number; entries: number } {
  const start = Math.max(0, zip.length - 22 - 65_535);
  let eocd = -1;
  for (let i = zip.length - 22; i >= start; i--)
    if (zip.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ArchiveError("not a zip file: no end-of-central-directory record");
  let entries: number = zip.readUInt16LE(eocd + 10);
  let offset: number = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || zip.readUInt32LE(locator) !== ZIP64_LOCATOR)
      throw new ArchiveError("zip64 archive without its locator");
    const at = Number(zip.readBigUInt64LE(locator + 8));
    if (at + 56 > zip.length || zip.readUInt32LE(at) !== ZIP64_EOCD)
      throw new ArchiveError("zip64 archive without its end record");
    entries = Number(zip.readBigUInt64LE(at + 32));
    offset = Number(zip.readBigUInt64LE(at + 48));
  }
  return { offset, entries };
}

/** Sizes and offset of one entry, from its zip64 extra field when the plain ones overflow. */
function zip64Fields(
  extra: Buffer,
  plain: { compressed: number; uncompressed: number; offset: number },
): { compressed: number; uncompressed: number; offset: number } {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const end = at + 4 + size;
    if (end > extra.length) throw new ArchiveError("an entry's extra field is cut short");
    if (id === 0x0001) {
      let p = at + 4;
      const next = (): number => {
        if (p + 8 > end) throw new ArchiveError("an entry's zip64 field is cut short");
        const value = Number(extra.readBigUInt64LE(p));
        p += 8;
        return value;
      };
      const out = { ...plain };
      if (out.uncompressed === 0xffffffff) out.uncompressed = next();
      if (out.compressed === 0xffffffff) out.compressed = next();
      if (out.offset === 0xffffffff) out.offset = next();
      return out;
    }
    at += 4 + size;
  }
  return plain;
}

/**
 * Take the named files of a zip, and nothing else: `entries` maps each
 * file's path in the archive to the path under `dest` it is written to.
 * Every named entry must be there exactly once, must be a plain file
 * (a directory or a link is refused), and must inflate to its declared
 * size and CRC-32; nothing is written until all of them have. Files are
 * written with mode 0644 (the caller makes its executable runnable).
 * Returns how many files were written.
 */
export function extractZipEntries(
  file: string,
  entries: Readonly<Record<string, string>>,
  dest: string,
): number {
  const places = placesOf(entries, dest);
  const zip = readFileSync(file);
  const { offset, entries: count } = centralDirectory(zip);
  const found = new Map<string, Buffer>();
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== ZIP_CENTRAL)
      throw new ArchiveError("a central directory entry is not where the zip says it is");
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const externalAttributes = zip.readUInt32LE(at + 38);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const sizes = zip64Fields(extra, {
      compressed: zip.readUInt32LE(at + 20),
      uncompressed: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
    if (!places.has(name)) continue;
    const quoted = JSON.stringify(name);
    if (found.has(name)) throw new ArchiveError(`entry ${quoted} is in the zip twice`);
    const type = (madeBy === 3 ? externalAttributes >>> 16 : 0) & 0o170000;
    if (name.endsWith("/") || type === 0o040000)
      throw new ArchiveError(`entry ${quoted} is a directory, not a file`);
    if (type === 0o120000) throw new ArchiveError(`entry ${quoted} is a link, not a file`);
    const local = sizes.offset;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== ZIP_LOCAL)
      throw new ArchiveError(`entry ${quoted} has no local header where the zip says`);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + sizes.compressed);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        // Never more than the entry declares, so a short entry cannot inflate into a huge one; the
        // declared size itself comes from the zip, whose SHA-256 the install checked first.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, sizes.uncompressed) });
      } catch (err) {
        throw new ArchiveError(
          `entry ${quoted} did not inflate within its declared size: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else
      throw new ArchiveError(
        `entry ${quoted} uses compression method ${method}; only stored and deflated entries are read`,
      );
    if (data.length !== sizes.uncompressed)
      throw new ArchiveError(`entry ${quoted} did not inflate to its declared size`);
    if (crc32(data) !== crc) throw new ArchiveError(`entry ${quoted} fails its CRC-32 check`);
    found.set(name, data);
  }
  return writeFound("zip", places, found);
}

/** The largest tar a release's installer comes in, uncompressed; elan's is 6 to 14 MB. */
const maxTarBytes = 256 * 1024 * 1024;

const text = (block: Buffer, start: number, length: number): string => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
};

/** An octal field, or GNU base-256 when the high bit of the first byte is set. */
const numeric = (block: Buffer, start: number, length: number): number => {
  const first = block[start] as number;
  if (first & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + length; i++) n = n * 256 + (block[i] as number);
    return n;
  }
  const t = text(block, start, length).trim();
  if (t.length === 0) return 0;
  if (!/^[0-7]+$/.test(t))
    throw new ArchiveError(`a tar header holds ${JSON.stringify(t)} where a number goes`);
  return Number.parseInt(t, 8);
};

/** `length key=value\n` records of a pax extended header. */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(at, space).toString("latin1"), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return out;
}

/**
 * Take the named files of a gzip-compressed tar, and nothing else, as
 * `extractZipEntries` does for a zip: `entries` maps each file's path in
 * the archive (after any pax or GNU long name) to its path under `dest`.
 * Every header's checksum is checked; a named entry must be a regular file.
 */
export function extractTarGzEntries(
  file: string,
  entries: Readonly<Record<string, string>>,
  dest: string,
): number {
  const places = placesOf(entries, dest);
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(file), { maxOutputLength: maxTarBytes });
  } catch (err) {
    throw new ArchiveError(
      `not a gzip-compressed tar within ${maxTarBytes} bytes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const found = new Map<string, Buffer>();
  let next: { path?: string; size?: number } = {};
  let at = 0;
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
    if (sum !== numeric(block, 148, 8)) throw new ArchiveError("a tar header fails its checksum");
    const type = block[156] === 0 ? "0" : String.fromCharCode(block[156] as number);
    const size =
      type === "x" || type === "L"
        ? numeric(block, 124, 12)
        : (next.size ?? numeric(block, 124, 12));
    const start = at + 512;
    if (start + size > tar.length)
      throw new ArchiveError("the tar ends inside an entry; the file is truncated");
    const data = tar.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const records = paxRecords(data);
      const path = records.get("path");
      const declared = records.get("size");
      if (declared !== undefined && !/^\d+$/.test(declared))
        throw new ArchiveError(`a pax header gives the size ${JSON.stringify(declared)}`);
      next = {
        ...(path === undefined ? {} : { path }),
        ...(declared === undefined ? {} : { size: Number(declared) }),
      };
      continue;
    }
    if (type === "L") {
      next = { ...next, path: text(data, 0, data.length) };
      continue;
    }
    if (type === "g") continue;
    // Only a POSIX header ("ustar\0") has a name prefix there; an old GNU one ("ustar  ") keeps times.
    const prefix = text(block, 257, 6) === "ustar" ? text(block, 345, 155) : "";
    const plain = text(block, 0, 100);
    const name = next.path ?? (prefix.length > 0 ? `${prefix}/${plain}` : plain);
    next = {};
    if (!places.has(name)) continue;
    const quoted = JSON.stringify(name);
    if (found.has(name)) throw new ArchiveError(`entry ${quoted} is in the tar twice`);
    if (type === "5") throw new ArchiveError(`entry ${quoted} is a directory, not a file`);
    if (type === "1" || type === "2")
      throw new ArchiveError(`entry ${quoted} is a link, not a file`);
    if (type !== "0" && type !== "7")
      throw new ArchiveError(`entry ${quoted} is of tar type ${JSON.stringify(type)}, not a file`);
    found.set(name, Buffer.from(data));
  }
  return writeFound("tar", places, found);
}
