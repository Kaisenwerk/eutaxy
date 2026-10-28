import { type PrngState, seedPrng } from "@eutaxy/core";
import type { Binder, Hint, SpecType } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { render } from "./checked.ts";
import {
  CannotGenerate,
  conforms,
  edgeAssignment,
  edgeLists,
  edgesOf,
  generate,
  inDomain,
  integerBound,
  regexAlphabet,
  shrinkCandidates,
  uniformBigInt,
} from "./generate.ts";

const binder = (type: SpecType, hint?: Hint): Binder => ({
  name: "x",
  type,
  ...(hint ? { hint } : {}),
});
const number = (hint?: Hint) => binder({ kind: "number" }, hint);
const int = (hint: Hint = {}) => number({ integer: true, ...hint });
const bigint = (hint?: Hint) => binder({ kind: "bigint" }, hint);
const string = (pattern?: string, flags = "") =>
  binder({ kind: "string" }, pattern === undefined ? undefined : { regex: { pattern, flags } });
const at = (value: string, inclusive: boolean) => ({ value, inclusive });

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
  test.each<[string, Binder]>([
    ["int", int()],
    ["nat", int({ lower: at("0", true) })],
    ["int in [10, 12]", int({ lower: at("10", true), upper: at("12", true) })],
    ["int in (0, inf)", int({ lower: at("0", false) })],
    ["int in [-5, 3)", int({ lower: at("-5", true), upper: at("3", false) })],
    ["number", number()],
    ["number in (0, 1)", number({ lower: at("0", false), upper: at("1", false) })],
    ["number up to -1000", number({ upper: at("-1_000", true) })],
    ["bigint", bigint()],
    ["bigint in (0n, 100n]", bigint({ lower: at("0n", false), upper: at("100n", true) })],
    ["boolean", binder({ kind: "boolean" })],
    ["string", string()],
    ["string /^[a-z]+$/", string("^[a-z]+$")],
    ["string /\\d{3}-\\d{2}/", string("\\d{3}-\\d{2}")],
    ["string alternation", string("^(foo|ba[rz])+(?:-[A-F0-9]{2,4})?$")],
    ["string negated class", string("^[^a-z\\s]{1,3}\\.$")],
    ["string timestamp", string("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$")],
    ["string lookahead", string("^(?=.)[ab]+$")],
  ])("%s: every draw is of the type and within the hint", (_name, b) => {
    for (const v of draws(b, 500)) expect(inDomain(b, v), render(v)).toBe(true);
  });

  test("the same seed draws the same values; another seed, others", () => {
    expect(draws(int(), 50, "a")).toEqual(draws(int(), 50, "a"));
    expect(draws(int(), 50, "a")).not.toEqual(draws(int(), 50, "b"));
  });

  test("integers are biased small and still reach the edges of the range", () => {
    const values = draws(int(), 2000) as number[];
    expect(values.filter((v) => Math.abs(v) <= 16).length).toBeGreaterThan(800);
    expect(values).toContain(2 ** 53 - 1);
    expect(values).toContain(-(2 ** 53 - 1));
    expect(values.every((v) => Number.isSafeInteger(v))).toBe(true);
    const guarded = draws(int({ lower: at("7", true) }), 500) as number[];
    expect(guarded).toContain(7);
    expect(Math.min(...guarded)).toBe(7);
  });

  test("numbers include the special values the hint admits, and only those", () => {
    const open = draws(number(), 3000) as number[];
    expect(open.some((v) => Number.isNaN(v))).toBe(true);
    expect(open).toContain(Number.POSITIVE_INFINITY);
    expect(open.some((v) => Object.is(v, -0))).toBe(true);
    expect(open.some((v) => Math.abs(v) > 1e100)).toBe(true);
    const unit = draws(number({ lower: at("0", false), upper: at("1", false) }), 500) as number[];
    expect(unit.every((v) => v > 0 && v < 1)).toBe(true);
    expect(unit).toContain(0.5);
  });

  test("bigints beyond the double range, within a hint exactly", () => {
    const wide = draws(bigint(), 1000) as bigint[];
    expect(wide.some((v) => v > 2n ** 64n || v < -(2n ** 64n))).toBe(true);
    const narrow = draws(
      bigint({ lower: at("0n", false), upper: at("3n", true) }),
      200,
    ) as bigint[];
    expect(new Set(narrow)).toEqual(new Set([1n, 2n, 3n]));
  });

  test("strings: edges and plain text; a regex hint draws from the pattern's characters", () => {
    const plain = draws(string(), 1000) as string[];
    expect(plain).toContain("");
    expect(plain).toContain("😀");
    expect(plain.some((s) => s.length > 10)).toBe(true);
    const lower = draws(string("^[a-z]+$"), 300) as string[];
    expect(lower.every((s) => /^[a-z]+$/.test(s))).toBe(true);
    expect(new Set(lower).size).toBeGreaterThan(100);
    const dashed = draws(string("^\\d{3}-\\d{2}$"), 50) as string[];
    expect(dashed.every((s) => /^\d{3}-\d{2}$/.test(s))).toBe(true);
    expect(new Set(dashed).size).toBeGreaterThan(40);
    // Lookahead is outside the walked subset: sampling over the pattern's characters still finds matches.
    const sampled = draws(string("^(?=.)[ab]+$"), 20) as string[];
    expect(sampled.every((s) => /^(?=.)[ab]+$/.test(s))).toBe(true);
  });

  test("literals, null, undefined, unions and records are drawn as their values", () => {
    expect(draws(binder({ kind: "literal", value: "a" }), 3)).toEqual(["a", "a", "a"]);
    expect(draws(binder({ kind: "null" }), 1)).toEqual([null]);
    const union = binder({
      kind: "union",
      members: [{ kind: "literal", value: "x" }, { kind: "literal", value: 1 }, { kind: "null" }],
    });
    expect(new Set(draws(union, 100))).toEqual(new Set(["x", 1, null]));
    const record = binder({
      kind: "record",
      fields: [
        { name: "n", type: { kind: "number" } },
        { name: "tag", type: { kind: "literal", value: "t" } },
      ],
    });
    for (const v of draws(record, 20)) {
      expect(typeof (v as { n: unknown }).n).toBe("number");
      expect((v as { tag: unknown }).tag).toBe("t");
    }
  });

  test("a hint no integer lies in is reported as gave_up, an unreadable type as unsupported", () => {
    const empty = int({ lower: at("0", false), upper: at("1", false) });
    expect(() => draws(empty, 1)).toThrow(CannotGenerate);
    try {
      draws(empty, 1);
    } catch (err) {
      expect((err as CannotGenerate).why).toBe("gave_up");
    }
    expect(() => draws(int({ lower: at("-5", true), upper: at("-6", true) }), 1)).toThrow(
      CannotGenerate,
    );
    expect(shrinkCandidates(empty, 5)).toEqual([]);
    try {
      draws(binder({ kind: "unknown", text: "Date" }), 1);
    } catch (err) {
      expect((err as CannotGenerate).why).toBe("unsupported");
    }
  });

  test("a bigint hint beyond the unhinted reach is drawn from the hint itself", () => {
    const huge = 1n << 200n;
    const b = bigint({ lower: at(`${huge}n`, true), upper: at(`${huge + 10n}n`, true) });
    for (const v of draws(b, 100) as bigint[]) expect(v >= huge && v <= huge + 10n).toBe(true);
    const oneSided = draws(bigint({ lower: at(`${huge}n`, true) }), 100) as bigint[];
    expect(oneSided.every((v) => v >= huge)).toBe(true);
    expect(oneSided.some((v) => v > huge + 1000n)).toBe(true);
  });

  test("a regex no draw matches is reported, not looped on", () => {
    expect(() => draws(string("^(?!)$"), 1)).toThrow(CannotGenerate);
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

describe("edgesOf and edgeAssignment", () => {
  test("doubles: the specials, within the hint; integers: the bounds and the small ones", () => {
    const doubles = edgesOf({ kind: "number" }, undefined);
    for (const v of [Number.NaN, 0, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(
        doubles.some((d) => Object.is(d, v)),
        String(v),
      ).toBe(true);
    const nonNegative = edgesOf({ kind: "number" }, { lower: at("0", true) });
    expect(nonNegative.some((d) => Number.isNaN(d as number))).toBe(false);
    expect(nonNegative.every((d) => (d as number) >= 0)).toBe(true);
    expect(
      edgesOf({ kind: "number" }, { integer: true, lower: at("3", true), upper: at("9", false) }),
    ).toEqual([3, 8, 4, 7]);
    expect(edgesOf({ kind: "bigint" }, { lower: at("0", true), upper: at("2", true) })).toEqual([
      0n,
      2n,
      1n,
    ]);
    // Number.isInteger(-0) holds, so an integer number binder has -0 among its edges too.
    expect(edgesOf({ kind: "number" }, { integer: true }).some((v) => Object.is(v, -0))).toBe(true);
  });

  test("strings within the regex, booleans, null, every member of a union, records field by field", () => {
    expect(edgesOf({ kind: "string" }, undefined)).toContain("");
    expect(edgesOf({ kind: "string" }, { regex: { pattern: "^[0-9]+$", flags: "" } })).toEqual([
      "0",
    ]);
    // A regex is tried only on edges as short as its random draws: the 100-character edge would
    // send a backtracking pattern like this one into exponential time, and this call would not return.
    expect(edgesOf({ kind: "string" }, { regex: { pattern: "^(a+)+b$", flags: "" } })).toEqual([]);
    expect(edgesOf({ kind: "boolean" }, undefined)).toEqual([false, true]);
    const status: SpecType = {
      kind: "union",
      members: [
        { kind: "literal", value: "invited" },
        { kind: "literal", value: "active" },
        { kind: "null" },
      ],
    };
    expect(edgesOf(status, undefined)).toEqual(["invited", "active", null]);
    const rec: SpecType = {
      kind: "record",
      fields: [
        { name: "ok", type: { kind: "boolean" } },
        { name: "n", type: { kind: "bigint" } },
      ],
    };
    const recs = edgesOf(rec, undefined);
    // The fields in step, then rotated (field k starting k places in), repeats dropped.
    const big = edgesOf({ kind: "bigint" }, undefined);
    expect(recs.length).toBeGreaterThan(big.length);
    expect(new Set(recs.map((r) => render(r))).size).toBe(recs.length);
    expect(recs.slice(0, 2)).toEqual([
      { ok: false, n: big[0] },
      { ok: true, n: big[1] },
    ]);
    expect(recs[big.length]).toEqual({ ok: false, n: big[1] });
    const span = edgesOf(
      {
        kind: "record",
        fields: [
          { name: "lo", type: { kind: "number" } },
          { name: "hi", type: { kind: "number" } },
        ],
      },
      undefined,
    ) as { lo: number; hi: number }[];
    // Equal edges meet (Infinity - Infinity), and so do different ones.
    expect(span.some((r) => r.lo === Number.POSITIVE_INFINITY && r.hi === r.lo)).toBe(true);
    expect(span.some((r) => Object.is(r.lo, 0) && Object.is(r.hi, -0))).toBe(true);
    expect(edgesOf({ kind: "unknown", text: "Map<string, number>" }, undefined)).toEqual([]);
  });

  test("nested records stay bounded: distinct edges only, at most 64 per record", () => {
    let wrapped: SpecType = { kind: "number" };
    for (let i = 0; i < 20; i++)
      wrapped = {
        kind: "record",
        fields: [
          { name: "tag", type: { kind: "literal", value: "x" } },
          { name: "child", type: wrapped },
        ],
      };
    const edges = edgesOf(wrapped, undefined);
    expect(edges.length).toBe(edgesOf({ kind: "number" }, undefined).length);
    let flags: SpecType = { kind: "number" };
    for (let i = 0; i < 4; i++)
      flags = {
        kind: "record",
        fields: [
          { name: "flag", type: { kind: "boolean" } },
          { name: "child", type: flags },
        ],
      };
    expect(edgesOf(flags, undefined).length).toBeLessThanOrEqual(64);
  });

  test("assignment i gives every binder its i-th edge, cycling; a binder without edges draws", () => {
    const binders: Binder[] = [
      { name: "b", type: { kind: "boolean" } },
      { name: "n", type: { kind: "number" } },
    ];
    const count = 2 * edgesOf({ kind: "number" }, undefined).length;
    const all: unknown[][] = [];
    let state: PrngState = seedPrng("e");
    for (let i = 0; i < count; i++) {
      const next = edgeAssignment(binders, edgeLists(binders), i, state);
      if (!next) throw new Error(`no edge assignment ${i}`);
      [all[i], state] = next;
    }
    expect(edgeAssignment(binders, edgeLists(binders), count, state)).toBeUndefined();
    expect(new Set(all.map((a) => a[0]))).toEqual(new Set([false, true]));
    expect(all.some((a) => Number.isNaN(a[1] as number))).toBe(true);
    const addressed: Binder = {
      name: "a",
      type: { kind: "string" },
      hint: { regex: { pattern: "^0x[0-9a-f]{4}$", flags: "" } },
    };
    const withAddress = [...binders, addressed];
    const [[, , a]] = edgeAssignment(withAddress, edgeLists(withAddress), 0, state) ?? [[]];
    expect(a).toMatch(/^0x[0-9a-f]{4}$/);
    const withUnknown: Binder[] = [
      ...binders,
      { name: "u", type: { kind: "unknown", text: "Date" } },
    ];
    expect(() => edgeAssignment(withUnknown, edgeLists(withUnknown), 0, state)).toThrow(
      CannotGenerate,
    );
  });
});

describe("shrinkCandidates", () => {
  test("-0 shrinks to 0, which === cannot tell apart from it", () => {
    for (const b of [number(), int()])
      expect(shrinkCandidates(b, -0).some((c) => Object.is(c, 0))).toBe(true);
    expect(shrinkCandidates(number(), 0).some((c) => Object.is(c, -0))).toBe(false);
  });

  test("numbers move toward zero, or the hint's end nearest it, never past the hint", () => {
    expect(shrinkCandidates(int(), 100)).toEqual([0, 50, 75, 88, 94, 97, 99]);
    expect(shrinkCandidates(int(), -3)).toEqual([0, -2]);
    expect(shrinkCandidates(int({ lower: at("10", true), upper: at("20", true) }), 16)).toEqual([
      10, 13, 15,
    ]);
    expect(shrinkCandidates(int({ lower: at("-20", true), upper: at("-10", true) }), -16)).toEqual([
      -10, -13, -15,
    ]);
    expect(shrinkCandidates(int(), 0)).toEqual([]);
    expect(shrinkCandidates(int({ lower: at("0", true) }), 1)).toEqual([0]);
    expect(shrinkCandidates(bigint({ lower: at("0n", false) }), 9n)).toEqual([1n, 5n, 7n, 8n]);
  });

  test("doubles truncate and halve; special values fall back to finite ones", () => {
    expect(shrinkCandidates(number(), 6.5).slice(0, 3)).toEqual([0, 6, 3.25]);
    expect(shrinkCandidates(number(), Number.NaN)).toEqual([
      0,
      1,
      -1,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]);
    const unit = number({ lower: at("0", false), upper: at("1", false) });
    for (const c of shrinkCandidates(unit, 0.75) as number[]) expect(c > 0 && c < 1).toBe(true);
  });

  test("strings get shorter and plainer, within the hint", () => {
    expect(shrinkCandidates(string(), "hello")).toEqual([
      "",
      "he",
      "lo",
      "ello",
      "hell",
      "helo",
      "aello",
    ]);
    expect(shrinkCandidates(string("^[a-z]+$"), "zz")).toEqual(["z", "az"]);
    expect(shrinkCandidates(string("^[a-z]+$"), "a")).toEqual([]);
  });

  test("true shrinks to false; nothing shrinks to itself", () => {
    const b = binder({ kind: "boolean" });
    expect(shrinkCandidates(b, true)).toEqual([false]);
    expect(shrinkCandidates(b, false)).toEqual([]);
  });

  test("a union moves to its simplest members first; a record shrinks one field at a time", () => {
    const nullable = binder({
      kind: "union",
      members: [
        { kind: "record", fields: [{ name: "n", type: { kind: "number" } }] },
        { kind: "null" },
      ],
    });
    expect(shrinkCandidates(nullable, { n: 4 })).toEqual([null, { n: 0 }, { n: 2 }, { n: 3 }]);
    expect(shrinkCandidates(nullable, null)).toEqual([]);
    const record = binder({
      kind: "record",
      fields: [
        { name: "n", type: { kind: "number" } },
        { name: "b", type: { kind: "boolean" } },
      ],
    });
    expect(shrinkCandidates(record, { n: 2, b: true })).toEqual([
      { n: 0, b: true },
      { n: 1, b: true },
      { n: 2, b: false },
    ]);
  });
});

describe("review findings", () => {
  test("shrinking values that hold bigints does not throw", () => {
    const record = binder({ kind: "record", fields: [{ name: "n", type: { kind: "bigint" } }] });
    expect(shrinkCandidates(record, { n: 5n })).toEqual([{ n: 0n }, { n: 3n }, { n: 4n }]);
    const union = binder({ kind: "union", members: [{ kind: "bigint" }, { kind: "number" }] });
    expect(shrinkCandidates(union, 5)).toEqual([0n, 0, 3, 4]);
  });

  test("a bound past every double bounds nothing; a fractional upper bound on a bigint is rounded down", () => {
    expect(integerBound({ value: "1e400", inclusive: false }, "upper")).toBeUndefined();
    const wide = int({ upper: at("1e400", false) });
    expect(() => draws(wide, 10)).not.toThrow();
    expect(inDomain(bigint({ upper: at("4.5", true) }), 5n)).toBe(false);
    expect(inDomain(bigint({ upper: at("4.5", true) }), 4n)).toBe(true);
    expect(inDomain(bigint({ lower: at("0.5", true) }), 0n)).toBe(false);
    expect(inDomain(bigint({ lower: at("0.5", true) }), 1n)).toBe(true);
  });

  test("-0 is of the literal type 0", () => {
    expect(conforms({ kind: "literal", value: 0 }, -0)).toBe(true);
    expect(conforms({ kind: "literal", value: "a" }, "a")).toBe(true);
    expect(conforms({ kind: "literal", value: 1 }, "1")).toBe(false);
  });
});
