import { describe, expect, test } from "vitest";
import { bytesEqual, utf8Encode } from "./utf8.ts";

// The reference encoder exists at runtime (Node, workerd); core itself does not depend on it.
declare const TextEncoder: new () => { encode(s: string): Uint8Array };

describe("utf8Encode", () => {
  test("matches TextEncoder on ASCII, 2-, 3- and 4-byte sequences", () => {
    const lone = String.fromCharCode(0xd800); // unpaired high surrogate
    const loneLow = String.fromCharCode(0xdc00); // unpaired low surrogate
    const samples = [
      "",
      "abc",
      "é",
      "€",
      "日本語",
      "😀",
      "a\u0000b",
      "😀x",
      lone,
      `a${loneLow}b`,
      `${lone}😀`, // unpaired then a valid pair
    ];
    for (const s of samples) {
      expect(bytesEqual(utf8Encode(s), new TextEncoder().encode(s))).toBe(true);
    }
  });
});

describe("bytesEqual", () => {
  test("compares length and content", () => {
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(bytesEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(bytesEqual(Uint8Array.from([1]), Uint8Array.from([1, 0]))).toBe(false);
  });
});
