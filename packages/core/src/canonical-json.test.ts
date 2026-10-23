import { describe, expect, test } from "vitest";
import { canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  test("sorts keys at every depth and omits whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("equal data serialises identically regardless of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test("normalises negative zero and rejects non-finite numbers", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  test("rejects undefined values hidden inside objects", () => {
    const sneaky = { a: undefined } as unknown as { a: null };
    expect(() => canonicalJson(sneaky)).toThrow(TypeError);
  });

  test("rejects sparse arrays instead of dropping or corrupting elements", () => {
    expect(() => canonicalJson(new Array(1) as unknown as number[])).toThrow(TypeError);
    expect(() => canonicalJson(new Array(2) as unknown as number[])).toThrow(TypeError);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    expect(() => canonicalJson([1, , 3] as unknown as number[])).toThrow(TypeError);
  });

  test("round-trips through JSON.parse", () => {
    const value = { s: 'é\n"q"', n: 1.5e300, arr: [null, true, false], o: {} };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});
