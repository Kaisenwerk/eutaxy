import { describe, expect, test } from "vitest";
import { patchProperty } from "./patch.ts";

describe("patchProperty", () => {
  test("replaces a value and puts the original descriptor back", () => {
    const target = {};
    Object.defineProperty(target, "f", {
      value: 1,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    const original = Object.getOwnPropertyDescriptor(target, "f");
    const restore = patchProperty(target, "f", { value: 2 });
    expect((target as { f: number }).f).toBe(2);
    expect(Object.getOwnPropertyDescriptor(target, "f")?.enumerable).toBe(true);
    restore();
    expect(Object.getOwnPropertyDescriptor(target, "f")).toEqual(original);
  });

  test("removes a property that was not there, and a second restore does nothing", () => {
    const target: { g?: number } = {};
    const restore = patchProperty(target, "g", { get: () => 3 });
    expect(target.g).toBe(3);
    expect(Object.keys(target)).toEqual([]);
    restore();
    expect("g" in target).toBe(false);
    target.g = 4;
    restore();
    expect(target.g).toBe(4);
  });

  test("throws where the property cannot be redefined", () => {
    expect(() => patchProperty(Object.freeze({ h: 1 }), "h", { value: 2 })).toThrow(TypeError);
  });
});
