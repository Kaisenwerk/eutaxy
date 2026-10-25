import { describe, expect, test } from "vitest";
import { nextFloat, nextInt, nextU32, type PrngState, seedPrng } from "./prng.ts";

function take(state: PrngState, n: number): number[] {
  const out: number[] = [];
  let s = state;
  for (let i = 0; i < n; i++) {
    const [v, next] = nextU32(s);
    out.push(v);
    s = next;
  }
  return out;
}

describe("seedPrng", () => {
  test("same seed gives the same state, different seeds differ", () => {
    expect(seedPrng(42)).toEqual(seedPrng(42));
    expect(seedPrng("run-1")).toEqual(seedPrng("run-1"));
    expect(seedPrng(42)).not.toEqual(seedPrng(43));
    expect(seedPrng("run-1")).not.toEqual(seedPrng("run-2"));
  });

  test("numeric seeds are taken modulo 2^32", () => {
    expect(seedPrng(1)).toEqual(seedPrng(1 + 2 ** 32));
  });

  test("never produces the all-zero state", () => {
    for (const seed of [0, 1, 2 ** 31, 2 ** 32 - 1, "", "0"]) {
      expect(seedPrng(seed).some((w) => w !== 0)).toBe(true);
    }
  });
});

describe("nextU32", () => {
  test("is deterministic: same seed, same sequence", () => {
    expect(take(seedPrng(7), 1000)).toEqual(take(seedPrng(7), 1000));
  });

  test("does not mutate its input state", () => {
    const s = seedPrng(7);
    const copy = [...s];
    nextU32(s);
    nextU32(s);
    expect([...s]).toEqual(copy);
    expect(Object.isFrozen(seedPrng(7))).toBe(false); // plain data, no proxies
  });

  test("yields 32-bit unsigned integers that are not all alike", () => {
    const xs = take(seedPrng("spread"), 1000);
    for (const x of xs) {
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(0xffffffff);
    }
    expect(new Set(xs).size).toBeGreaterThan(990);
  });
});

describe("nextFloat", () => {
  test("lies in [0, 1)", () => {
    let s = seedPrng(3);
    for (let i = 0; i < 1000; i++) {
      const [f, next] = nextFloat(s);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      s = next;
    }
  });
});

describe("nextInt", () => {
  test("lies in [0, bound) and covers every value", () => {
    let s = seedPrng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const [v, next] = nextInt(s, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
      s = next;
    }
    expect(seen.size).toBe(7);
  });

  test("bound 1 returns 0 without consuming state", () => {
    const s = seedPrng(9);
    expect(nextInt(s, 1)).toEqual([0, s]);
  });

  test("rejects invalid bounds", () => {
    const s = seedPrng(9);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 32 + 1]) {
      expect(() => nextInt(s, bad)).toThrow(RangeError);
    }
  });
});
