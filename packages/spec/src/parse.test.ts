import { describe, expect, test } from "vitest";
import type { Formula } from "./ir.ts";
import { LemmaSyntaxError, parseProperty } from "./parse.ts";
import { printProperty } from "./print.ts";

const atom = (text: string): Formula => ({ kind: "atom", text });

describe("the prefix", () => {
  test("groups bind several names with one domain and guard", () => {
    expect(
      parseProperty("forall (x y: number ∈ (0, 1]) (s: string ∈ /a+/u) { f(x, y, s) }").binders,
    ).toEqual([
      {
        name: "x",
        domain: "number",
        guard: {
          kind: "interval",
          lower: { value: "0", inclusive: false },
          upper: { value: "1", inclusive: true },
        },
      },
      {
        name: "y",
        domain: "number",
        guard: {
          kind: "interval",
          lower: { value: "0", inclusive: false },
          upper: { value: "1", inclusive: true },
        },
      },
      { name: "s", domain: "string", guard: { kind: "regex", pattern: "a+", flags: "u" } },
    ]);
  });

  test("∀, in, Infinity and signs are spellings", () => {
    const p = parseProperty("∀ (n: int in [-5, Infinity)) { n >= -5 }");
    expect(p.binders[0]?.guard).toEqual({
      kind: "interval",
      lower: { value: "-5", inclusive: true },
      upper: { value: "∞", inclusive: false },
    });
  });

  test.each([
    ["forall (x: int ∈ [0, ∞]) { x >= 0 }", "exclusive"],
    ["forall (x: int ∈ [3, 2]) { x >= 0 }", "empty"],
    ["forall (x: int ∈ [2, 2)) { x >= 0 }", "empty"],
    ["forall (x: int ∈ [0.5, 2]) { x >= 0 }", "int literal"],
    ["forall (x: number ∈ /a/) { x >= 0 }", "regex guard applies to string"],
    ["forall (s: string ∈ /a/g) { s === s }", "s and u flags"],
    ["forall (x: int) (x: int) { x === x }", "bound twice"],
    ["forall { true }", "at least one binder"],
    ["forall (x: int) x > 0", "expected {"],
  ])("rejects %s (%s)", (text, message) => {
    expect(() => parseProperty(text)).toThrow(message);
  });

  test("integer endpoints compare exactly, beyond 2^53 too", () => {
    expect(
      parseProperty("forall (b: bigint ∈ [9007199254740992n, 9007199254740993n)) { b > 0n }")
        .binders[0]?.guard,
    ).toBeDefined();
    expect(() =>
      parseProperty("forall (b: bigint ∈ [9007199254740993n, 9007199254740992n]) { b > 0n }"),
    ).toThrow("empty");
  });

  test("an inclusive ∞ is a number's own value", () => {
    expect(parseProperty("forall (x: number ∈ [0, ∞]) { x >= 0 }").binders[0]?.guard).toBeDefined();
  });
});

describe("the formula", () => {
  test("a root implication is the preconditions; every segment but the last", () => {
    const p = parseProperty("forall (x: int) { x > 0 ==> x < 10 -> f(x) }");
    expect(p.requires).toEqual([atom("x > 0"), atom("x < 10")]);
    expect(p.claim).toEqual(atom("f(x)"));
  });

  test("a parenthesized implication at the root is material", () => {
    const p = parseProperty("forall (x: int) { (x > 0 → f(x)) }");
    expect(p.requires).toEqual([]);
    expect(p.claim).toEqual({
      kind: "implies",
      antecedents: [atom("x > 0")],
      consequent: atom("f(x)"),
    });
  });

  test("precedence: ¬ over ∧ over ∨ over → over ↔", () => {
    const p = parseProperty("forall (a b c: boolean) { ¬a ∧ b ∨ c ↔ c }");
    expect(p.claim).toEqual({
      kind: "iff",
      left: {
        kind: "or",
        operands: [
          { kind: "and", operands: [{ kind: "not", operand: atom("a") }, atom("b")] },
          atom("c"),
        ],
      },
      right: atom("c"),
    });
  });

  test("ASCII spellings of the connectives", () => {
    const p = parseProperty("forall (a b: boolean) { (a /\\ b \\/ a) <-> a }");
    expect(p.claim.kind).toBe("iff");
  });

  test("iff as a member name is not the connective", () => {
    expect(parseProperty("forall (x: int) { api.iff(x) ∧ api?.iff(x) }").claim).toEqual({
      kind: "and",
      operands: [atom("api.iff(x)"), atom("api?.iff(x)")],
    });
  });

  test("parentheses that belong to the expression stay in the atom", () => {
    expect(parseProperty("forall (x: int) { (x + 1) * 2 > 0 }").claim).toEqual(
      atom("(x + 1) * 2 > 0"),
    );
  });

  test("glyphs inside strings, templates and regexes are text", () => {
    expect(parseProperty('forall (s: string) { s !== "a ∧ b" }').claim).toEqual(
      atom('s !== "a ∧ b"'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the annotation itself holds a template literal.
    expect(parseProperty('forall (s: string) { `${s ? "∨" : s}` !== "x" }').claim.kind).toBe(
      "atom",
    );
    expect(parseProperty("forall (s: string) { /∧|\\//.test(s) ∨ true }").claim.kind).toBe("or");
  });

  test("equations are SameValue at an atom's top level", () => {
    expect(parseProperty("forall (x: number) { f(x) ≢ g(x) }").claim).toEqual({
      kind: "equation",
      left: "f(x)",
      right: "g(x)",
      negated: true,
    });
  });

  test("TypeScript islands: as, generics, non-null, arrow defaults", () => {
    expect(parseProperty("forall (x: int) { (f(x) as number) > 0 }").claim.kind).toBe("atom");
    expect(parseProperty("forall (x: int) { id<number>(x) === x }").claim.kind).toBe("atom");
    expect(parseProperty("forall (x: int) { g(x)! > 0 }").claim.kind).toBe("atom");
    expect(parseProperty("forall (x: int) { [x].every((v = 0) => v >= x) }").claim.kind).toBe(
      "atom",
    );
  });

  test.each([
    ["forall (x: int) { x > 0 ↔ x > 1 ↔ x > 2 }", "non-associative"],
    ["forall (x: int) { a ≡ b ≡ c }", "non-associative"],
    ["forall (x: int) { x > 0 && x < 2 }", "∧"],
    ["forall (x: int) { x > 0 || x < 2 }", "∨"],
    ["forall (x: boolean) { !x }", "¬"],
    ["forall (x: int) { x == 1 }", "loose"],
    ["forall (x: int) { f(x != 1) }", "loose"],
    ["forall (x: int) { (x = 1) > 0 }", "assignments"],
    ["forall (x: int) { g(x += 1) }", "assignments"],
    ["forall (x: int) { x ≠ 1 }", "≢"],
    ["forall (x: int) { f(Object.is(x ≡ 1)) }", "Object.is"],
    ["forall (x: int) { a ? b : c ≡ d }", "parenthesize"],
    ["forall (x: int) { a === b ≡ c }", "parenthesize"],
    ["forall (x: int) { xs.every(y => y > 0 ∧ y < 2) }", "inside a JavaScript expression"],
    ["forall (x: int) { forall (y: int) { x } }", "quantifiers nest"],
    ["forall (x: int) { ∃ y }", "quantifiers nest"],
    ["forall (x: int) { x ∈ [0, 1] }", "binder group"],
    ["forall (x: int) { x > 0 } extra", "last token"],
    ["forall (x: int) { }", "empty"],
    ["forall (x: int) { x > 0 ∧ }", "missing an operand"],
    ["forall (x: int) { f(x }", "property body"],
    ['forall (x: int) { "x }', "unterminated"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the property itself holds a template literal.
    ['forall (x: int) { `${x = 1}` === "1" }', "assignments"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: as above.
    ['forall (x: int) { `${x == 1}` === "true" }', "loose"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: as above.
    ['forall (x: int) { `${`${x ∧ x}`}` === "" }', "inside a JavaScript expression"],
  ])("rejects %s (%s)", (text, message) => {
    expect(() => parseProperty(text)).toThrow(LemmaSyntaxError);
    expect(() => parseProperty(text)).toThrow(message);
  });

  test("errors say which stage rejected the annotation", () => {
    const stage = (text: string) => {
      try {
        parseProperty(text);
      } catch (err) {
        return (err as LemmaSyntaxError).stage;
      }
      return null;
    };
    expect(stage("exists (x: int) { x > 0 }")).toBe("prefix");
    expect(stage("forall (x: int) { x == 0 }")).toBe("formula");
  });
});

describe("printing", () => {
  test.each([
    "forall (x y: int) { x + y === y + x }",
    "forall (x: int) { x > 0 → x < 10 → f(x) }",
    "forall (x: int) { (x > 0 → f(x)) }",
    "forall (a b c: boolean) { (a ∨ b) ∨ c }",
    "forall (a b c: boolean) { a ∧ (b ↔ c) }",
    "forall (a b c: boolean) { ¬(a ∧ b) ↔ ¬a ∨ ¬b }",
    "forall (a b: boolean) { (a → b) → a }",
    "forall (x: number ∈ (0, 1]) (n: bigint ∈ [0n, ∞)) (s: string ∈ /a|b/su) { f(x, n, s) ≡ true }",
  ])("round-trips %s", (text) => {
    const parsed = parseProperty(text);
    expect(printProperty(parsed)).toBe(text);
    expect(parseProperty(printProperty(parsed))).toEqual(parsed);
  });
});
