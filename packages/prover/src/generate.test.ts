import { type PrngState, seedPrng } from "@eutaxy/core";
import { type Binder, extractSpecs } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { inDomain, render } from "./checked.ts";
import {
  CannotGenerate,
  generate,
  regexAlphabet,
  shrinkCandidates,
  uniformBigInt,
} from "./generate.ts";

const binder = (text: string): Binder => {
  const b = extractSpecs(`/** @ensures{p} ${text} */\nexport function f(x) {}`).functions[0]
    ?.ensures[0]?.property.binders[0];
  if (!b) throw new Error(`no binder in ${text}`);
  return b;
};

function draws(b: Binder, n: number, seed = "s"): unknown[] {
  let state: PrngState = seedPrng(seed);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const [v, next] = generate(b, state);
    state = next;
    out.push(v);
  }
  return out;
}

describe("generate", () => {
  test.each([
    "forall (x: int) { true }",
    "forall (x: nat) { true }",
    "forall (x: int ∈ [10, 12]) { true }",
    "forall (x: int ∈ (0, ∞)) { true }",
    "forall (x: nat ∈ [-5, 3)) { true }",
    "forall (x: number) { true }",
    "forall (x: number ∈ (0, 1)) { true }",
    "forall (x: number ∈ [-∞, -1_000]) { true }",
    "forall (x: bigint) { true }",
    "forall (x: bigint ∈ (0n, 100n]) { true }",
    "forall (x: boolean) { true }",
    "forall (x: string) { true }",
    "forall (x: string ∈ /^[a-z]+$/) { true }",
    "forall (x: string ∈ /\\d{3}-\\d{2}/) { true }",
    "forall (x: string ∈ /^(foo|ba[rz])+(?:-[A-F0-9]{2,4})?$/) { true }",
    "forall (x: string ∈ /^[^a-z\\s]{1,3}\\.$/) { true }",
    "forall (x: string ∈ /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/) { true }",
    "forall (x: string ∈ /^(?=.)[ab]+$/) { true }",
  ])("%s: every draw is in the domain and guard", (text) => {
    const b = binder(text);
    for (const v of draws(b, 500)) expect(inDomain(b, v), render(v)).toBe(true);
  });

  test("the same seed draws the same values; another seed, others", () => {
    const b = binder("forall (x: int) { true }");
    expect(draws(b, 50, "a")).toEqual(draws(b, 50, "a"));
    expect(draws(b, 50, "a")).not.toEqual(draws(b, 50, "b"));
  });

  test("integers are biased small and still reach the edges of the range", () => {
    const b = binder("forall (x: int) { true }");
    const values = draws(b, 2000) as number[];
    expect(values.filter((v) => Math.abs(v) <= 16).length).toBeGreaterThan(800);
    expect(values).toContain(2 ** 53 - 1);
    expect(values).toContain(-(2 ** 53 - 1));
    expect(values.every((v) => Number.isSafeInteger(v))).toBe(true);
    const guarded = draws(binder("forall (x: int ∈ [7, ∞)) { true }"), 500) as number[];
    expect(guarded).toContain(7);
    expect(Math.min(...guarded)).toBe(7);
  });

  test("numbers include the special values a guard admits, and only those", () => {
    const open = draws(binder("forall (x: number) { true }"), 3000) as number[];
    expect(open.some((v) => Number.isNaN(v))).toBe(true);
    expect(open).toContain(Number.POSITIVE_INFINITY);
    expect(open.some((v) => Object.is(v, -0))).toBe(true);
    expect(open.some((v) => Math.abs(v) > 1e100)).toBe(true);
    const unit = draws(binder("forall (x: number ∈ (0, 1)) { true }"), 500) as number[];
    expect(unit.every((v) => v > 0 && v < 1)).toBe(true);
    expect(unit).toContain(0.5);
  });

  test("bigints beyond the double range, within a guard exactly", () => {
    const wide = draws(binder("forall (x: bigint) { true }"), 1000) as bigint[];
    expect(wide.some((v) => v > 2n ** 64n || v < -(2n ** 64n))).toBe(true);
    const narrow = draws(binder("forall (x: bigint ∈ (0n, 3n]) { true }"), 200) as bigint[];
    expect(new Set(narrow)).toEqual(new Set([1n, 2n, 3n]));
  });

  test("strings: edges and plain text; a regex guard draws from the pattern's characters", () => {
    const plain = draws(binder("forall (x: string) { true }"), 1000) as string[];
    expect(plain).toContain("");
    expect(plain).toContain("😀");
    expect(plain.some((s) => s.length > 10)).toBe(true);
    const lower = draws(binder("forall (x: string ∈ /^[a-z]+$/) { true }"), 300) as string[];
    expect(lower.every((s) => /^[a-z]+$/.test(s))).toBe(true);
    expect(new Set(lower).size).toBeGreaterThan(100);
    const dashed = draws(binder("forall (x: string ∈ /^\\d{3}-\\d{2}$/) { true }"), 50) as string[];
    expect(dashed.every((s) => /^\d{3}-\d{2}$/.test(s))).toBe(true);
    expect(new Set(dashed).size).toBeGreaterThan(40);
    // Lookahead is outside the walked subset: sampling over the pattern's characters still finds matches.
    const sampled = draws(binder("forall (x: string ∈ /^(?=.)[ab]+$/) { true }"), 20) as string[];
    expect(sampled.every((s) => /^(?=.)[ab]+$/.test(s))).toBe(true);
  });

  test("a guard no integer lies in is reported, not thrown through", () => {
    expect(() => draws(binder("forall (x: int ∈ (0, 1)) { true }"), 1)).toThrow(CannotGenerate);
    expect(() => draws(binder("forall (x: nat ∈ [-5, -1]) { true }"), 1)).toThrow(CannotGenerate);
    expect(shrinkCandidates(binder("forall (x: int ∈ (0, 1)) { true }"), 5)).toEqual([]);
  });

  test("a bigint guard beyond the unguarded reach is drawn from the guard itself", () => {
    const huge = 1n << 200n;
    const b = binder(`forall (x: bigint ∈ [${huge}n, ${huge + 10n}n]) { true }`);
    for (const v of draws(b, 100) as bigint[]) expect(v >= huge && v <= huge + 10n).toBe(true);
    const oneSided = draws(binder(`forall (x: bigint ∈ [${huge}n, ∞)) { true }`), 100) as bigint[];
    expect(oneSided.every((v) => v >= huge)).toBe(true);
    expect(oneSided.some((v) => v > huge + 1000n)).toBe(true);
  });

  test("a regex no draw matches is reported, not looped on", () => {
    expect(() => draws(binder("forall (x: string ∈ /^(?!)$/) { true }"), 1)).toThrow(
      CannotGenerate,
    );
  });

  test("regexAlphabet: literals, ranges and escapes; metacharacters left out", () => {
    expect(regexAlphabet("^[a-c]+$").sort()).toEqual(["a", "b", "c"]);
    expect(regexAlphabet("\\d-x|y").sort()).toEqual([..."0123456789", "x", "y"].sort());
    expect(regexAlphabet("\\.\\(")).toEqual([".", "("]);
    expect(regexAlphabet("[^\\s]")).toEqual([" "]);
  });

  test("uniformBigInt covers a span wider than one word", () => {
    let state: PrngState = seedPrng(1);
    const seen = new Set<bigint>();
    for (let i = 0; i < 2000; i++) {
      const [v, next] = uniformBigInt(0n, 2n ** 40n, state);
      state = next;
      expect(v >= 0n && v <= 2n ** 40n).toBe(true);
      seen.add(v >> 37n);
    }
    for (let slice = 0n; slice < 8n; slice++) expect(seen.has(slice)).toBe(true);
  });
});

describe("shrinkCandidates", () => {
  test("numbers move toward zero, or the guard's end nearest it, never past the guard", () => {
    expect(shrinkCandidates(binder("forall (x: int) { true }"), 100)).toEqual([
      0, 50, 75, 88, 94, 97, 99,
    ]);
    expect(shrinkCandidates(binder("forall (x: int) { true }"), -3)).toEqual([0, -2]);
    expect(shrinkCandidates(binder("forall (x: int ∈ [10, 20]) { true }"), 16)).toEqual([
      10, 13, 15,
    ]);
    expect(shrinkCandidates(binder("forall (x: int ∈ [-20, -10]) { true }"), -16)).toEqual([
      -10, -13, -15,
    ]);
    expect(shrinkCandidates(binder("forall (x: int) { true }"), 0)).toEqual([]);
    expect(shrinkCandidates(binder("forall (x: nat) { true }"), 1)).toEqual([0]);
    expect(shrinkCandidates(binder("forall (x: bigint ∈ (0n, ∞)) { true }"), 9n)).toEqual([
      1n,
      5n,
      7n,
      8n,
    ]);
  });

  test("doubles truncate and halve; special values fall back to finite ones", () => {
    const b = binder("forall (x: number) { true }");
    expect(shrinkCandidates(b, 6.5).slice(0, 3)).toEqual([0, 6, 3.25]);
    expect(shrinkCandidates(b, Number.NaN)).toEqual([
      0,
      1,
      -1,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]);
    const unit = binder("forall (x: number ∈ (0, 1)) { true }");
    for (const c of shrinkCandidates(unit, 0.75) as number[]) expect(c > 0 && c < 1).toBe(true);
  });

  test("strings get shorter and plainer, within the guard", () => {
    expect(shrinkCandidates(binder("forall (x: string) { true }"), "hello")).toEqual([
      "",
      "he",
      "lo",
      "ello",
      "hell",
      "helo",
      "aello",
    ]);
    const lower = binder("forall (x: string ∈ /^[a-z]+$/) { true }");
    expect(shrinkCandidates(lower, "zz")).toEqual(["z", "az"]);
    expect(shrinkCandidates(lower, "a")).toEqual([]);
  });

  test("true shrinks to false; nothing shrinks to itself", () => {
    const b = binder("forall (x: boolean) { true }");
    expect(shrinkCandidates(b, true)).toEqual([false]);
    expect(shrinkCandidates(b, false)).toEqual([]);
  });
});
