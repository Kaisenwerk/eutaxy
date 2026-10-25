import { type PrngState, seedPrng } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { drawRegex, parseRegex, UnsupportedRegex } from "./regex-gen.ts";

function sample(pattern: string, flags = "", n = 200): string[] {
  const tree = parseRegex(pattern, flags);
  let state: PrngState = seedPrng(pattern);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const [s, next] = drawRegex(tree, state);
    state = next;
    out.push(s);
  }
  return out;
}

describe("regex generation", () => {
  test.each([
    ["^[a-z]+$", ""],
    ["^\\d{3}-\\d{4}$", ""],
    ["^(foo|bar|baz)?-?[A-Z]{2}$", ""],
    ["^[^0-9]{2}$", ""],
    ["^.\\.$", ""],
    ["^(?:ab)*c$", ""],
    ["^x{2,}y{0,2}z{3}$", ""],
    ["^[\\w-]+@[\\w-]+\\.[a-z]{2,3}$", ""],
    ["^[\\]\\-a]+$", ""],
    ["^\\u0041\\x42\\u{43}\\t\\n$", "u"],
    ["^(?<name>[ab])\\b$", ""],
    ["^[^\\d\\s]$", ""],
    ["^a.b$", "s"],
    ["^ABC$", "i"],
    ["^\\S\\D\\W$", ""],
  ])("every draw of /%s/%s matches it", (pattern, flags) => {
    const re = new RegExp(pattern, flags);
    for (const s of sample(pattern, flags)) expect(s, JSON.stringify(s)).toMatch(re);
  });

  test("draws vary and the same seed repeats them", () => {
    expect(new Set(sample("^[a-z]{1,6}$")).size).toBeGreaterThan(150);
    expect(sample("^[a-z]{1,6}$")).toEqual(sample("^[a-z]{1,6}$"));
    expect(sample("^(a|b)c?$").sort()).toEqual(expect.arrayContaining(["a", "ac", "b", "bc"]));
  });

  test("unbounded quantifiers stay short", () => {
    for (const s of sample("^a*$")) expect(s.length).toBeLessThanOrEqual(4);
    for (const s of sample("^a+$")) expect(s.length).toBeGreaterThanOrEqual(1);
  });

  test("what the walker does not understand is refused, not guessed", () => {
    for (const pattern of [
      "(?=a)b",
      "(?!a)b",
      "(?<=a)b",
      "(a)\\1",
      "\\p{L}",
      "\\k<x>",
      "(a",
      "a)",
      "*a",
      "[z-a]",
    ])
      expect(() => parseRegex(pattern, ""), pattern).toThrow(UnsupportedRegex);
    expect(() => parseRegex("a", "v")).toThrow(UnsupportedRegex);
    // Repetition past what a draw can build is refused before drawing, or while a draw grows.
    expect(() => parseRegex("a{0,4294967296}", "")).toThrow(UnsupportedRegex);
    expect(() => parseRegex("a{1001}", "")).toThrow(UnsupportedRegex);
    expect(() => drawRegex(parseRegex("(a{1000}){1000}", ""), seedPrng(1))).toThrow(
      UnsupportedRegex,
    );
    expect(sample("^a{1000}$", "", 1)[0]).toHaveLength(1000);
    expect(() => parseRegex("\\u{43}", "")).toThrow(UnsupportedRegex);
    expect(() => parseRegex("[^\\s\\S]", "")).toThrow(UnsupportedRegex);
    expect(() => parseRegex("[]", "")).toThrow(UnsupportedRegex);
    // Nested repetitions of an empty match build nothing yet visit a billion nodes: refused by the step budget.
    expect(() =>
      drawRegex(parseRegex("(?:(?:(?:a{0}){1000}){1000}){1000}", ""), seedPrng(1)),
    ).toThrow(UnsupportedRegex);
  });
});
