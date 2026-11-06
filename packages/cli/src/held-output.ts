/**
 * What a module running ahead of its turn writes, held until its turn:
 * in memory up to a limit, then in a file, so a module that writes a lot
 * while an earlier one is still running cannot exhaust the report's heap.
 * Drained, it gives back exactly the text it was given, in order.
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export class HeldOutput {
  readonly #limit: number;
  readonly #readBytes: number;
  #chunks: string[] = [];
  #bytes = 0;
  #dir: string | undefined;
  #fd: number | undefined;

  /** `limitBytes` is held in memory; past it, everything goes to a file, read back `readBytes` at a time. */
  constructor(limitBytes = 1 << 20, readBytes = 1 << 16) {
    this.#limit = limitBytes;
    this.#readBytes = readBytes;
  }

  /** Whether the text held so far went past the limit into a file. */
  get spilled(): boolean {
    return this.#fd !== undefined;
  }

  push(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.#fd === undefined && this.#bytes + bytes <= this.#limit) {
      this.#chunks.push(text);
      this.#bytes += bytes;
      return;
    }
    if (this.#fd === undefined) {
      this.#dir = mkdtempSync(join(tmpdir(), "eutaxy-report-"));
      this.#fd = openSync(join(this.#dir, "held"), "w+");
    }
    writeSync(this.#fd, text);
  }

  /** Everything held, in order, to `out`; then nothing is held and the file is gone. */
  drain(out: (text: string) => void): void {
    for (const text of this.#chunks) out(text);
    this.#chunks = [];
    this.#bytes = 0;
    if (this.#fd === undefined) return;
    try {
      // A multi-byte character may straddle two reads; the decoder joins it.
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(this.#readBytes);
      for (let at = 0; ; ) {
        const n = readSync(this.#fd, buffer, 0, buffer.length, at);
        if (n === 0) break;
        at += n;
        const text = decoder.write(buffer.subarray(0, n));
        if (text !== "") out(text);
      }
      const rest = decoder.end();
      if (rest !== "") out(rest);
    } finally {
      this.discard();
    }
  }

  /** Drop the file, if any. */
  discard(): void {
    if (this.#fd !== undefined) closeSync(this.#fd);
    if (this.#dir !== undefined) rmSync(this.#dir, { recursive: true, force: true });
    this.#fd = undefined;
    this.#dir = undefined;
  }
}
