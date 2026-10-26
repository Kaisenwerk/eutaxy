import { describe, expect, test } from "vitest";
import { readExpression, readSubset } from "./subset.ts";

const refund = `
export interface RefundDecision {
  readonly ok: boolean;
  /** The refunded total after this decision. */
  readonly refunded: number;
}

/** @ensures{p} forall (x: int) { true } */
export function decideRefund(captured: number, refunded: number, amount: number): RefundDecision {
  if (amount <= 0 || refunded + amount > captured) return { ok: false, refunded };
  return { ok: true, refunded: refunded + amount };
}
`;

describe("readSubset", () => {
  test("records, parameters, early returns and shorthand fields", () => {
    const m = readSubset(refund);
    expect(m.records).toEqual([
      {
        name: "RefundDecision",
        fields: [
          { name: "ok", type: { kind: "bool" } },
          { name: "refunded", type: { kind: "int" } },
        ],
      },
    ]);
    const f = m.functions[0];
    expect(f?.name).toBe("decideRefund");
    expect(f?.params.map((p) => p.name)).toEqual(["captured", "refunded", "amount"]);
    expect(f?.returns).toEqual({ kind: "record", name: "RefundDecision" });
    expect(f?.body).toEqual({
      kind: "cond",
      test: {
        kind: "binary",
        op: "||",
        left: {
          kind: "binary",
          op: "<=",
          left: { kind: "var", name: "amount" },
          right: { kind: "int", value: "0" },
        },
        right: {
          kind: "binary",
          op: ">",
          left: {
            kind: "binary",
            op: "+",
            left: { kind: "var", name: "refunded" },
            right: { kind: "var", name: "amount" },
          },
          right: { kind: "var", name: "captured" },
        },
      },
      ifTrue: {
        kind: "record",
        fields: [
          { name: "ok", value: { kind: "bool", value: false } },
          { name: "refunded", value: { kind: "var", name: "refunded" } },
        ],
      },
      ifFalse: {
        kind: "record",
        fields: [
          { name: "ok", value: { kind: "bool", value: true } },
          {
            name: "refunded",
            value: {
              kind: "binary",
              op: "+",
              left: { kind: "var", name: "refunded" },
              right: { kind: "var", name: "amount" },
            },
          },
        ],
      },
    });
  });

  test("a returning if/else nested in an if branch, followed by more statements", () => {
    const m = readSubset(`
export function f(a: boolean, b: boolean): number {
  if (a) {
    if (b) {
      return 1;
    } else {
      return 2;
    }
  }
  return 3;
}
`);
    expect(m.outside).toEqual([]);
    expect(m.functions[0]?.body.kind).toBe("cond");
  });

  test("const bindings, if/else blocks, nested conditionals and calls to earlier functions", () => {
    const m = readSubset(`
export function clamp(x: number, lo: number, hi: number): number {
  const below = x < lo;
  if (below) { return lo; } else { return x > hi ? hi : x; }
}
export function clampTwice(x: number): number {
  return clamp(clamp(x, 0, 10), -(1), 5);
}
type Pair = { readonly a: number, readonly b: boolean };
export function pair(n: number): Pair { return { a: n * 2, b: !(n === 0) }; }
`);
    expect(m.functions.map((f) => f.name)).toEqual(["clamp", "clampTwice", "pair"]);
    expect(m.functions[0]?.body.kind).toBe("let");
    expect(m.functions[1]?.body).toEqual({
      kind: "call",
      callee: "clamp",
      args: [
        {
          kind: "call",
          callee: "clamp",
          args: [
            { kind: "var", name: "x" },
            { kind: "int", value: "0" },
            { kind: "int", value: "10" },
          ],
        },
        { kind: "int", value: "-1" },
        { kind: "int", value: "5" },
      ],
    });
    expect(m.records[0]?.name).toBe("Pair");
  });

  test("every function the subset takes is read, callees before callers; the names asked for must exist", () => {
    const m = readSubset(
      "export function g(x: number): number { return f(x); }\nexport function f(x: number): number { return x; }",
      ["g"],
    );
    // Callees first, whatever the source order.
    expect(m.functions.map((f) => f.name)).toEqual(["f", "g"]);
    expect(m.outside).toEqual([]);
    const missing = readSubset("export function f(x: number): number { return x; }", ["h"]);
    expect(missing.outside).toEqual([
      { name: "h", line: 0, message: "the module declares no function h at its top level" },
    ]);
  });

  test("a function outside the subset is reported, not thrown, and so is every caller of it", () => {
    const m = readSubset(`
export function loops(n: number): number { let t = 0; for (;;) { t = n; } return t; }
export function caller(n: number): number { return loops(n) + 1; }
export function indirect(n: number): number { return caller(n); }
export function fine(n: number): number { return n; }
`);
    expect(m.functions.map((f) => f.name)).toEqual(["fine"]);
    expect(m.outside.map((o) => o.name)).toEqual(["loops", "caller", "indirect"]);
    expect(m.outside[0]?.message).toContain("mutable binding");
    expect(m.outside[1]?.message).toBe(
      "calls loops, which is outside the subset: a mutable binding (use const)",
    );
    expect(m.outside[2]?.message).toContain("calls caller, which is outside the subset");
  });

  test.each([
    ["export function f(x: number): number { let y = x; return y; }", "mutable binding"],
    ["export function f(x: number): number { for (;;) {} }", "a loop"],
    ["export function f(x: number) { return x; }", "without a return type"],
    ["export function f(x: string | null): number { return 1; }", "arrays, generics, unions"],
    [
      'export function f(x: "a" | null): number { return 1; }',
      "a union mixing string literals with null",
    ],
    ['export function f(x: string): boolean { return x < "b"; }', "< on a string and a string"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
    ["export function f(x: string): string { return `${x}`; }", "a template literal"],
    ['export function f(x: string): boolean { return x === "\\ud83d"; }', "lone surrogate"],
    ['export function f(x: string): boolean { return x === "\\101"; }', "escape sequence"],
    ['export function f(x: string): boolean { return x === "\\u{110000}"; }', "beyond U+10FFFF"],
    ["export function f(x: number): number { return x / 2; }", "the / operator"],
    ["export function f(x: number): number { return x % 2; }", "the % operator"],
    ["export function f(x: number): number { return 1.5; }", "numeric literal 1.5"],
    ["export function f(x: number): boolean { return x == 1; }", "the == operator"],
    ["export function f(x: number): number { return Math.abs(x); }", "Math, which is neither"],
    ["export function f(x: number): number { if (x > 0) return 1; }", "does not return"],
    ["export function f(x: number): number { return x; return x; }", "statements after a return"],
    ["export function f(x: number): number { return 'a' + 1; }", "+ on a string and a int"],
    ["export function f(x: number[]): number { return 1; }", "arrays, generics"],
    ["export function f(x?: number): number { return 1; }", "optional parameter x"],
    ["export async function f(x: number): number { return x; }", "async function"],
    ["export function f(this: number, x: number): number { return x; }", "a this parameter"],
    ["export function f(x: number): number { throw new Error('x'); }", "throw"],
    ["export function f(x: number): number { return x as number; }", "the as operator"],
    ["export function f(x: number): number { return y; }", "y, which is neither"],
    [
      "export interface P { a?: number }\nexport function f(x: number): P { return {}; }",
      "record type P is outside the subset: optional field a",
    ],
    ["export function f(x: number): number { return [x][0]; }", "an array literal"],
  ])("outside the subset: %s", (source, reason) => {
    const m = readSubset(source);
    expect(m.functions).toEqual([]);
    expect(m.outside).toHaveLength(1);
    expect(m.outside[0]?.message).toContain(reason);
  });

  test.each([
    [
      "export interface P { a: number }\nexport function f(x: number): boolean { return { a: x } === { a: x }; }",
      "=== on records compares references",
    ],
    ["export function f(x: number): boolean { return x; }", "f returns a int but declares bool"],
    [
      "export function f(x: number): number { return x > 0 ? 1 : true; }",
      "branches of a conditional have different types",
    ],
    [
      "export function f(n: number): number { if (n) return 1; return 0; }",
      "a condition that is a int",
    ],
    ["export function f(n: number): number { return n ? 1 : 0; }", "a condition that is a int"],
    ["export function f(x: number, b: boolean): number { return x + b; }", "+ on a int and a bool"],
    ["export function f(x: number): boolean { return x && x; }", "&& on a int and a int"],
    [
      "export function f(x: number): boolean { return x === true; }",
      "=== between a int and a bool",
    ],
    ["export function f(x: number): number { return -(x > 0); }", "unary minus on a bool"],
    [
      "export function g(x: number): number { return x; }\nexport function f(x: number): number { return g(x, x); }",
      "g takes 1 argument(s), called with 2",
    ],
    [
      "export function g(x: number): number { return x; }\nexport function f(b: boolean): number { return g(b); }",
      "argument 1 of g is a bool, not the int it takes",
    ],
    [
      "export interface P { mk: number }\nexport function f(x: number): P { return { mk: x }; }",
      "record type P is outside the subset: field mk takes a name Lean's structures reserve",
    ],
    [
      "export interface P { a: number }\nexport function f(x: number): P { return { b: x }; }",
      "matches no declared record type",
    ],
    [
      "export interface P { __proto__: number }\nexport function f(x: number): P { return { __proto__: x }; }",
      "__proto__",
    ],
  ])("typed outside the subset: %s", (source, reason) => {
    const m = readSubset(source);
    expect(m.functions.map((f) => f.name)).not.toContain("f");
    expect(m.outside.find((o) => o.name === "f")?.message).toContain(reason);
  });

  test("a function used as a value anywhere is not trusted, and neither are its callers", () => {
    const m = readSubset(`
export function f(x: number): number { return x; }
export function g(x: number): number { return f(x); }
f = (x: number): number => x + 1;
export function h(x: number): number { return x; }
`);
    expect(m.functions.map((fn) => fn.name)).toEqual(["h"]);
    expect(m.outside.map((o) => [o.name, o.line])).toEqual([
      ["f", 4],
      ["g", 3],
    ]);
    expect(m.outside[0]?.message).toContain("is used as a value in the module");
    // Every assignment form, every alias, in a block, a body or a template substitution.
    for (const line of [
      "f &&= (x: number): number => x + 1;",
      "[f] = [(x: number): number => x + 1];",
      "({ g: f } = { g: (x: number): number => x + 1 });",
      "for (f of []) {}",
      "for ([f] of [[(x: number): number => x + 1]]) {}",
      "f++;",
      "(f) = (x: number): number => x + 1;",
      "f! = (x: number): number => x + 1;",
      "(f)! = (x: number): number => x + 1;",
      "f as unknown = (x: number): number => x + 1;",
      "if (true) { f = (x: number): number => x + 1; }",
      "export function g(x: number): number { f = g; return x; }",
      "const alias = f;",
      "[1].map(f);",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
      "const s = `${f}`;",
      "const o = { f };",
      "f`tag`;",
    ]) {
      const m2 = readSubset(`export function f(x: number): number { return x; }\n${line}`);
      expect(
        m2.functions.map((fn) => fn.name),
        line,
      ).not.toContain("f");
    }
    // A call, a property of something else, an object key or a new binding is not such a use.
    const fine = readSubset(
      "export function f(x: number): number { return x; }\nexport function g(x: number): number { return f(x); }\nconst o = { f: 1 }; o.f = 2; o?.f;",
    );
    expect(fine.functions.map((fn) => fn.name)).toEqual(["f", "g"]);
  });

  test("a direct eval anywhere puts the whole module outside; an indirect one does not", () => {
    const m = readSubset(
      'export function f(x: number): number { return x; }\nexport function g(x: number): number { return x; }\neval("f = (x) => x + 1");',
    );
    expect(m.functions).toEqual([]);
    expect(m.outside.map((o) => o.name)).toEqual(["f", "g"]);
    expect(m.outside[0]?.message).toContain("mentions eval directly");
    for (const line of [
      '(eval)("f = (x) => x + 1");',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
      'const s = `${eval("f = (x) => x + 1")}`;',
      "const e = eval;",
    ]) {
      const m2 = readSubset(`export function f(x: number): number { return x; }\n${line}`);
      expect(m2.functions, line).toEqual([]);
    }
    const indirect = readSubset(
      'export function f(x: number): number { return x; }\nconst e = globalThis.eval; e("1");',
    );
    expect(indirect.functions.map((fn) => fn.name)).toEqual(["f"]);
  });

  test("an identifier escape, or source the scanner cannot read, puts the module outside", () => {
    const escaped = readSubset(
      "export function f(x: number): number { return x; }\n\\u0066 = (x: number): number => x + 1;",
    );
    expect(escaped.functions).toEqual([]);
    expect(escaped.outside[0]?.message).toContain("identifier escape");
    const inTemplate = readSubset(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
      "export function f(x: number): number { return x; }\nconst s = `${\\u0066 = (x: number): number => x + 1}`;",
    );
    expect(inTemplate.functions).toEqual([]);
    const broken = readSubset(
      'export function f(x: number): number { return x; }\nconst s = "unterminated',
      ["f"],
    );
    expect(broken.functions).toEqual([]);
    expect(broken.outside).toEqual([
      { name: "f", line: 0, message: expect.stringContaining("could not be tokenized") },
    ]);
  });

  test("a generator is refused by name, not thrown over", () => {
    const m = readSubset(
      "export function* f(x: number): Generator<number> { yield x; }\nexport function g(x: number): number { return x; }",
      ["f", "g"],
    );
    expect(m.functions.map((fn) => fn.name)).toEqual(["g"]);
    expect(m.outside[0]).toMatchObject({ name: "f", message: "a generator function" });
  });

  test("a line break after return, or a bare return, is refused (JavaScript returns undefined there)", () => {
    const broken = readSubset("export function f(x: number): number {\n  return\n  x;\n}");
    expect(broken.outside[0]?.message).toContain("line break after return");
    const bare = readSubset(
      "export function f(x: number): number { if (x > 0) return; return x; }",
    );
    expect(bare.outside[0]?.message).toBe("a return without a value");
  });

  test("a type alias that is no record is skipped to its end, not past the next declaration", () => {
    const m = readSubset(`
export type Id = number;
type Status = "invited" | "active" | { kind: "other" };
export function f(x: number): number { return x; }
`);
    expect(m.functions.map((fn) => fn.name)).toEqual(["f"]);
    expect(m.records).toEqual([]);
    expect(
      readSubset("type Id = string;\nexport function f(x: number): number { return x; }", ["f"])
        .outside,
    ).toEqual([]);
  });

  test("callees come before callers whatever the source order; recursion is outside", () => {
    const m = readSubset(`
export function f(x: number): number { return g(x) + 1; }
export function g(x: number): number { return h(x); }
function h(x: number): number { return x; }
export function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
export function even(n: number): boolean { return n === 0 ? true : odd(n - 1); }
export function odd(n: number): boolean { return n === 0 ? false : even(n - 1); }
export function usesFact(n: number): number { return fact(n); }
`);
    expect(m.functions.map((fn) => fn.name)).toEqual(["h", "g", "f"]);
    expect(m.outside.map((o) => o.name).sort()).toEqual(["even", "fact", "odd", "usesFact"]);
    expect(m.outside.find((o) => o.name === "fact")?.message).toContain("recursive");
    expect(m.outside.find((o) => o.name === "usesFact")?.message).toContain(
      "calls fact, which is outside",
    );
  });

  test("record literals are typed by their fields' types too; ambiguity is refused", () => {
    const m = readSubset(`
export interface A { v: number }
export interface B { v: boolean }
export interface C { v: number }
export function a(x: number): A { return { v: x }; }
export function b(x: number): B { return { v: x > 0 }; }
export function wrong(x: number): A { return { v: x > 0 }; }
export function two(x: number): C { return { v: x }; }
`);
    // A and C have the same fields, so a literal of those fields fits both: a and two are refused alike.
    expect(m.functions.map((fn) => fn.name)).toEqual(["b"]);
    // { v: x > 0 } fits B, so wrong is typed as returning B against its declared A.
    expect(m.outside.find((o) => o.name === "wrong")?.message).toBe(
      "wrong returns a B but declares A",
    );
    const only = readSubset(
      "export interface A { v: number }\nexport function f(x: number): A { return { v: x > 0 }; }",
    );
    expect(only.outside[0]?.message).toBe("field v of a A literal holds a bool, not a int");
    expect(m.outside.find((o) => o.name === "a")?.message).toContain("matches A and C alike");
    expect(m.outside.find((o) => o.name === "two")?.message).toContain("matches A and C alike");
    const annotated = readSubset(
      "export function f(x: number): number { const y: boolean = x + 1; return x; }",
    );
    expect(annotated.outside[0]?.message).toBe("const y is annotated bool but holds a int");
  });

  test("strings: literals with escapes, joining, equality, literal unions as string, string fields", () => {
    const m = readSubset(`
export interface T { readonly kind: string; readonly code: number }
export function decide(status: "invited" | "active" | "disabled"): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}
export function key(address: string): string { return "evm:" + address; }
export function esc(): string { return "a\\"b\\\\c\\n\\x41\\u0042\\u{1F600}"; }
export function tag(n: number): T { return { kind: n < 0 ? "neg" : "pos", code: n }; }
`);
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["decide", "key", "esc", "tag"]);
    expect(m.functions[0]?.params[0]?.type).toEqual({ kind: "string" });
    expect(m.functions[0]?.returns).toEqual({ kind: "string" });
    expect(m.functions[2]?.body).toEqual({ kind: "string", value: 'a"b\\c\nAB😀' });
  });

  test("an error names the line", () => {
    const m = readSubset(
      "export function f(x: number): number {\n  return x;\n}\nexport function g(x: number): number {\n  return x / 2;\n}",
    );
    expect(m.outside).toEqual([{ name: "g", line: 5, message: "the / operator" }]);
  });

  test("declarations that are not functions or records are skipped", () => {
    const m = readSubset(`
import { x } from "./x.ts";
import type { Foo } from "./foo.ts";
import type Bar from "./bar.ts"
export type { Foo };
export { x as y };
export * from "./z.ts";
export const limit = 5;
const helper = (a: number) => a + 1;
export function f(x: number): number { return x; }
`);
    expect(m.functions.map((f) => f.name)).toEqual(["f"]);
  });
});

describe("readExpression", () => {
  test("a property's leaf over binders and module functions", () => {
    const m = readSubset(refund);
    const scope = new Map([
      ["captured", { kind: "int" as const }],
      ["refunded", { kind: "int" as const }],
      ["amount", { kind: "int" as const }],
    ]);
    const e = readExpression(
      "decideRefund(captured, refunded, amount).refunded <= captured",
      scope,
      m,
    );
    expect(e.kind).toBe("binary");
    expect(() => readExpression("decideRefund(captured) extra", scope, m)).toThrow(
      "unexpected extra",
    );
    expect(() => readExpression("other(captured)", scope, m)).toThrow("other, which is neither");
    const partial = readSubset(
      "export function loops(n: number): number { let t = 0; return t; }\nexport function f(n: number): number { return n; }",
    );
    expect(() => readExpression("loops(n)", new Map([["n", { kind: "int" }]]), partial)).toThrow(
      "a call to loops, which is outside the subset",
    );
  });
});
