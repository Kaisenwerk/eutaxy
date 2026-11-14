/**
 * Test support: writing the two archive formats `archive.ts` reads, so the
 * install tests need no release file. Not part of the command.
 */

import { crc32, deflateRawSync, zstdCompressSync } from "node:zlib";

export interface TarEntry {
  readonly name: string;
  readonly data?: Buffer | string;
  readonly mode?: number;
  /** `0` file (default), `5` directory, `2` symlink, `1` hard link, `x` pax header, `L` GNU long name. */
  readonly type?: string;
  readonly linkName?: string;
}

export function tarEntry(entry: TarEntry): Buffer {
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  header.write((entry.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 7);
  header.write("0000000", 108, 7);
  header.write("0000000", 116, 7);
  header.write(data.length.toString(8).padStart(11, "0"), 124, 11);
  header.write("00000000000", 136, 11);
  header.write("        ", 148, 8);
  header.write(entry.type ?? "0", 156, 1);
  header.write(entry.linkName ?? "", 157, 100);
  header.write("ustar", 257, 5);
  header.write("00", 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

/** One `length key=value\n` record of a pax header. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return `${length}${body}`;
}

export function tar(entries: readonly TarEntry[]): Buffer {
  return Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
}

export function tarZst(entries: readonly TarEntry[]): Buffer {
  return zstdCompressSync(tar(entries));
}

export interface ZipEntry {
  readonly name: string;
  readonly data?: Buffer | string;
  /** Unix mode, stored in the external attributes as a Unix-made zip stores it. */
  readonly mode?: number;
  readonly deflate?: boolean;
  /** The uncompressed size the headers declare, when it should not be the true one. */
  readonly declaredSize?: number;
  /** The CRC-32 the headers declare, when it should not be the true one. */
  readonly crc?: number;
  /** An extra field for the central directory entry. */
  readonly extra?: Buffer;
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const plain = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const method = e.deflate ? 8 : 0;
    const data = e.deflate ? deflateRawSync(plain) : plain;
    const crc = e.crc ?? crc32(plain);
    const declared = e.declaredSize ?? plain.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(declared, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(e.extra?.length ?? 0, 30);
    c.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name, e.extra ?? Buffer.alloc(0));
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
