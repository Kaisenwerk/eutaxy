import { describe, expect, test } from "vitest";
import { templateSubstitutions, tokenize } from "./tokens.ts";

const kinds = (text: string) => tokenize(text).map((t) => [t.kind, t.text]);

describe("tokenize", () => {
  test("a slash after a non-null assertion divides", () => {
    expect(kinds("x! / 2")).toEqual([
      ["ident", "x"],
      ["punct", "!"],
      ["punct", "/"],
      ["number", "2"],
    ]);
    expect(kinds("f()!! / y / 3").filter(([k]) => k === "regex")).toEqual([]);
    expect(kinds("!/a/.test(s)")[1]).toEqual(["regex", "/a/"]);
    expect(kinds("x++ / 2 + y-- / 3").filter(([k]) => k === "regex")).toEqual([]);
    // A keyword spelled as a member name ends an operand like any other.
    expect(kinds("obj.in / 2 / obj.return").filter(([k]) => k === "regex")).toEqual([]);
    expect(kinds("++/a/.lastIndex")[1]).toEqual(["regex", "/a/"]);
  });

  test("a slash after a control statement's condition starts a regex", () => {
    expect(kinds('if (x) /[a"b]/.test(String(x));')[4]).toEqual(["regex", '/[a"b]/']);
    expect(kinds("while (f(x)) /a/.exec(s)")[7]).toEqual(["regex", "/a/"]);
    expect(kinds("(x) / 2").filter(([k]) => k === "regex")).toEqual([]);
  });

  test("a slash after a statement block starts a regex; after an object literal it divides", () => {
    expect(kinds('if (!x) { return false; } /"/.test(x);').find(([k]) => k === "regex")).toEqual([
      "regex",
      '/"/',
    ]);
    expect(kinds("x = ({ a: 1 }) / 2").filter(([k]) => k === "regex")).toEqual([]);
    expect(kinds("y = { a: 1 }.a / 2").filter(([k]) => k === "regex")).toEqual([]);
  });

  test("template substitutions are scanned like code: regexes, strings, comments, nested templates", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test is a template literal.
    const t = "`a${/}/.test(s)}b${'}'}c${/* } */ x}d${`${y}`}e`";
    expect(kinds(t)).toEqual([["template", t]]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: as above.
    expect(templateSubstitutions(t)).toEqual(["/}/.test(s)", "'}'", "/* } */ x", "`${y}`"]);
  });
});
