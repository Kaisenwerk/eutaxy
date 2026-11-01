/**
 * Reading the two archive formats the prover releases come in, with Node's
 * standard library alone: a tar stream compressed with zstd (Lean) and a zip
 * (Z3). Entries are written under one destination directory; an entry whose
 * path would leave it, or a link pointing out of it, is refused, since the
 * archive is downloaded. The tar is read as it decompresses, so a release
 * of hundreds of megabytes never sits in memory; a zip is read from its
 * central directory, entry by entry.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createZstdDecompress, inflateRawSync } from "node:zlib";

export class ArchiveError extends Error {}

/** The entry's place under `dest`, refused when it would be outside. */
function placeOf(dest: string, name: string): string {
  if (name.includes("\0")) throw new ArchiveError("an entry name holds a NUL byte");
  const target = resolve(dest, name);
  if (target !== dest && !target.startsWith(dest + sep))
    throw new ArchiveError(
      `entry ${JSON.stringify(name)} would be written outside the toolchain directory`,
    );
  return target;
}

/** A symlink's target must stay under `dest` too. */
function checkLink(dest: string, at: string, linkTo: string): void {
  const target = resolve(dirname(at), linkTo);
  if (target !== dest && !target.startsWith(dest + sep))
    throw new ArchiveError(
      `link ${JSON.stringify(linkTo)} would point outside the toolchain directory`,
    );
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function setMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  const bits = mode & 0o777;
  if (bits !== 0) chmodSync(path, bits | 0o600);
}

/** Tar header fields, from a 512-byte block. */
interface TarHeader {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly type: string;
  readonly linkName: string;
}

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
  return t.length === 0 ? 0 : Number.parseInt(t, 8);
};

function parseHeader(block: Buffer): TarHeader {
  const magic = text(block, 257, 6);
  const name = text(block, 0, 100);
  const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
  return {
    name: prefix.length > 0 ? `${prefix}/${name}` : name,
    mode: numeric(block, 100, 8),
    size: numeric(block, 124, 12),
    type: block[156] === 0 ? "0" : String.fromCharCode(block[156] as number),
    linkName: text(block, 157, 100),
  };
}

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

/** Where an entry's remaining bytes go: a file being written, a small header read whole, or nowhere. */
type Sink =
  | { readonly fd: number; readonly at: string; readonly mode: number }
  | { readonly chunks: Buffer[]; readonly kind: "pax" | "longname" }
  | { readonly skip: true };

/**
 * Reads a tar stream block by block as its chunks arrive. A file entry's
 * bytes are written to disk as they come; pax and GNU long-name entries are
 * read into memory (they are small) and apply to the entry that follows.
 */
class TarReader {
  readonly dest: string;
  buffer: Buffer = Buffer.alloc(0);
  current: { remaining: number; padding: number; sink: Sink } | undefined;
  /** Overrides for the next entry from a pax or long-name entry. */
  next: { path?: string; linkpath?: string; size?: number } = {};
  zeroBlocks = 0;
  ended = false;
  entries = 0;

  constructor(dest: string) {
    this.dest = dest;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.ended) return;
      if (this.current) {
        const take = Math.min(this.current.remaining, this.buffer.length);
        if (take > 0) {
          const part = this.buffer.subarray(0, take);
          if ("fd" in this.current.sink) writeSync(this.current.sink.fd, part);
          else if ("chunks" in this.current.sink) this.current.sink.chunks.push(Buffer.from(part));
          this.buffer = this.buffer.subarray(take);
          this.current.remaining -= take;
        }
        if (this.current.remaining > 0) return;
        const skip = Math.min(this.current.padding, this.buffer.length);
        this.buffer = this.buffer.subarray(skip);
        this.current.padding -= skip;
        if (this.current.padding > 0) return;
        this.finish();
        continue;
      }
      if (this.buffer.length < 512) return;
      const block = this.buffer.subarray(0, 512);
      this.buffer = this.buffer.subarray(512);
      if (block.every((b) => b === 0)) {
        if (++this.zeroBlocks >= 2) this.ended = true;
        continue;
      }
      this.zeroBlocks = 0;
      this.begin(parseHeader(block));
    }
  }

  begin(header: TarHeader): void {
    const size = this.next.size ?? header.size;
    const padding = (512 - (size % 512)) % 512;
    if (header.type === "x" || header.type === "L") {
      const kind = header.type === "x" ? "pax" : "longname";
      this.current = { remaining: size, padding, sink: { chunks: [], kind } };
      return;
    }
    const name = this.next.path ?? header.name;
    const linkName = this.next.linkpath ?? header.linkName;
    this.next = {};
    this.entries++;
    const at = placeOf(this.dest, name);
    if (header.type === "0" || header.type === "7") {
      ensureDir(dirname(at));
      const fd = openSync(at, "w");
      this.current = { remaining: size, padding, sink: { fd, at, mode: header.mode } };
      if (size === 0) this.finish();
      return;
    }
    if (header.type === "5") ensureDir(at);
    else if (header.type === "2") {
      checkLink(this.dest, at, linkName);
      ensureDir(dirname(at));
      rmSync(at, { force: true });
      symlinkSync(linkName, at);
    } else if (header.type === "1") {
      ensureDir(dirname(at));
      copyFileSync(placeOf(this.dest, linkName), at);
    }
    // Devices, FIFOs and vendor types carry nothing a toolchain needs; data any of these has is skipped.
    if (size > 0) this.current = { remaining: size, padding, sink: { skip: true } };
  }

  finish(): void {
    const current = this.current as NonNullable<TarReader["current"]>;
    this.current = undefined;
    if ("fd" in current.sink) {
      closeSync(current.sink.fd);
      setMode(current.sink.at, current.sink.mode);
      return;
    }
    if (!("chunks" in current.sink)) return;
    const data = Buffer.concat(current.sink.chunks);
    if (current.sink.kind === "longname") {
      this.next.path = text(data, 0, data.length);
      return;
    }
    const records = paxRecords(data);
    const path = records.get("path");
    const linkpath = records.get("linkpath");
    const size = records.get("size");
    if (path !== undefined) this.next.path = path;
    if (linkpath !== undefined) this.next.linkpath = linkpath;
    if (size !== undefined) this.next.size = Number(size);
  }

  /** Close the file being written, if any. */
  release(): void {
    if (this.current && "fd" in this.current.sink) closeSync(this.current.sink.fd);
  }

  end(): void {
    this.release();
    if (this.current)
      throw new ArchiveError("the tar stream ended inside an entry; the file is truncated");
  }
}

/** Unpack a zstd-compressed tar into `dest`, which must exist and be empty. */
export async function extractTarZst(file: string, dest: string): Promise<number> {
  const reader = new TarReader(resolve(dest));
  const source = createReadStream(file).pipe(createZstdDecompress());
  try {
    for await (const chunk of source) reader.push(chunk as Buffer);
  } catch (err) {
    reader.release();
    source.destroy();
    throw err;
  }
  reader.end();
  return reader.entries;
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
    if (zip.readUInt32LE(at) !== ZIP64_EOCD)
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
    if (id === 0x0001) {
      let p = at + 4;
      const out = { ...plain };
      if (out.uncompressed === 0xffffffff) {
        out.uncompressed = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      if (out.compressed === 0xffffffff) {
        out.compressed = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      if (out.offset === 0xffffffff) out.offset = Number(extra.readBigUInt64LE(p));
      return out;
    }
    at += 4 + size;
  }
  return plain;
}

/** Unpack a zip into `dest`, which must exist and be empty. */
export function extractZip(file: string, dest: string): number {
  const root = resolve(dest);
  const zip = readFileSync(file);
  const { offset, entries } = centralDirectory(zip);
  let at = offset;
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(at) !== ZIP_CENTRAL)
      throw new ArchiveError("a central directory entry is not where the zip says it is");
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const method = zip.readUInt16LE(at + 10);
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
    const local = sizes.offset;
    if (zip.readUInt32LE(local) !== ZIP_LOCAL)
      throw new ArchiveError(
        `entry ${JSON.stringify(name)} has no local header where the zip says`,
      );
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + sizes.compressed);
    const mode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    const place = placeOf(root, name);
    const isDirectory = name.endsWith("/") || (mode & 0o170000) === 0o040000;
    if (isDirectory) {
      ensureDir(place);
      continue;
    }
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else
      throw new ArchiveError(
        `entry ${JSON.stringify(name)} uses compression method ${method}; only stored and deflated entries are read`,
      );
    if (data.length !== sizes.uncompressed)
      throw new ArchiveError(`entry ${JSON.stringify(name)} did not inflate to its declared size`);
    ensureDir(dirname(place));
    if ((mode & 0o170000) === 0o120000) {
      const linkTo = data.toString("utf8");
      checkLink(root, place, linkTo);
      rmSync(place, { force: true });
      symlinkSync(linkTo, place);
      continue;
    }
    writeFileSync(place, data);
    setMode(place, mode);
  }
  return entries;
}

/**
 * When an archive puts everything under one top-level directory, as the
 * releases do (`lean-4.35.0-linux/`, `z3-5.3.2-x64-glibc-2.39/`), move
 * its contents up so the executable is at the path the table names.
 */
export function flattenSingleDirectory(dest: string): void {
  const entries = readdirSync(dest, { withFileTypes: true });
  if (entries.length !== 1 || !(entries[0] as { isDirectory(): boolean }).isDirectory()) return;
  const inner = join(dest, (entries[0] as { name: string }).name);
  for (const name of readdirSync(inner)) {
    const to = join(dest, name);
    if (existsSync(to)) throw new ArchiveError(`cannot flatten the archive: ${name} exists twice`);
    renameSync(join(inner, name), to);
  }
  rmSync(inner, { recursive: true, force: true });
}
