import { describe, expect, test } from "vitest";
import { toJson } from "./index.ts";

describe("toJson", () => {
  test("keeps JSON data as is", () => {
    expect(toJson({ a: [1, "x", true, null], b: undefined })).toEqual({
      a: [1, "x", true, null],
      b: null,
    });
    // biome-ignore lint/suspicious/noSparseArray: a hole is what is being tested
    expect(toJson([1, , 3])).toEqual([1, null, 3]);
  });

  test("writes numbers JSON cannot hold, bigints and functions as strings", () => {
    expect(toJson([Number.NaN, -0, Number.POSITIVE_INFINITY, 3n, () => 1, Symbol("s")])).toEqual([
      "NaN",
      "-0",
      "Infinity",
      "3",
      "<function>",
      "Symbol(s)",
    ]);
  });

  test("reads runtime objects the same on every machine", () => {
    expect(
      toJson({
        d: new Date(0),
        bad: new Date(Number.NaN),
        bytes: new Uint8Array(3),
        buf: new ArrayBuffer(2),
        set: new Set([1, 2]),
        map: new Map([["k", 1]]),
        err: new TypeError("no"),
      }),
    ).toEqual({
      d: "1970-01-01T00:00:00.000Z",
      bad: "Invalid Date",
      bytes: "<bytes 3>",
      buf: "<bytes 2>",
      set: [1, 2],
      map: [["k", 1]],
      err: "TypeError: no",
    });
  });

  test("reads class instances by their own keys", () => {
    class Money {
      readonly cents = 5;
      readonly currency = "EUR";
    }
    expect(toJson(new Money())).toEqual({ cents: 5, currency: "EUR" });
  });

  test("stops at cycles and depth, and never throws", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(toJson(cyclic)).toEqual({ self: "<nested>" });
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(JSON.stringify(toJson(deep))).toContain('"<nested>"');
    const shared = { n: 1 };
    expect(toJson([shared, shared])).toEqual([{ n: 1 }, { n: 1 }]);
    const throwing = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    expect(toJson(throwing)).toEqual({ x: "<unreadable>" });
  });

  test("keeps an own __proto__ key a key", () => {
    const own = toJson(JSON.parse('{"__proto__":{"approved":true}}'));
    expect(Object.hasOwn(own as object, "__proto__")).toBe(true);
  });

  test("tries a platform's own encoding first on every object", () => {
    const extra = (v: object) => (v instanceof Uint8Array ? `hex:${v.join("")}` : undefined);
    expect(toJson({ a: [new Uint8Array([1, 2])], b: new Date(0) }, extra)).toEqual({
      a: ["hex:12"],
      b: "1970-01-01T00:00:00.000Z",
    });
  });
});
