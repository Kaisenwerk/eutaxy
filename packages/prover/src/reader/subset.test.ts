import { describe, expect, test } from "vitest";
import {
  type Expr,
  listKinds,
  readArrowBody,
  readExpression,
  readSubset,
  renameVars,
  restrictModule,
  type SubsetType,
  typeOf,
} from "./subset.ts";

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
      // Each literal carries the type its context gives it: the declared return type.
      ifTrue: {
        kind: "record",
        fields: [
          { name: "ok", value: { kind: "bool", value: false } },
          { name: "refunded", value: { kind: "var", name: "refunded" } },
        ],
        type: { kind: "record", name: "RefundDecision" },
      },
      ifFalse: {
        kind: "record",
        type: { kind: "record", name: "RefundDecision" },
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
    ['export function f(x: string): boolean { return x < "b"; }', "< on a string and a string"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
    ["export function f(x: string): string { return `${x}`; }", "a template literal"],
    ['export function f(x: string): boolean { return x === "\\ud83d"; }', "lone surrogate"],
    ['export function f(x: string): boolean { return x === "\\101"; }', "escape sequence"],
    ['export function f(x: string): boolean { return x === "\\u{110000}"; }', "0x10FFFF"],
    ["export function f(x: number): number { return x / 2; }", "the / operator"],
    ["export function f(x: number): number { return x % 2; }", "the % operator"],
    ["export function f(x: number): number { return 1.5; }", "numeric literal 1.5"],
    ["export function f(x: number): boolean { return x == 1; }", "the == operator"],
    ["export function f(x: number): number { return Math.abs(x); }", "Math, which is neither"],
    ["export function f(x: number): number { if (x > 0) return 1; }", "does not return"],
    ["export function f(x: number): number { return x; return x; }", "statements after a return"],
    ["export function f(x: number): number { return 'a' + 1; }", "+ on a string and a int"],
    ["export function f(xs: readonly number[]): number { return xs[1] ?? 0; }", "other than xs[0]"],
    [
      "export function f(xs: readonly number[]): readonly number[] { return xs.slice(2); }",
      "slice with",
    ],
    [
      "export function f(xs: readonly number[]): number { return xs.indexOf(1); }",
      "the method indexOf",
    ],
    [
      "export function f(xs: readonly number[]): readonly number[] { return xs.map((x) => { return x; }); }",
      "a block body",
    ],
    [
      "export function f(xs: readonly number[]): readonly number[] { return [...xs, 1]; }",
      "a spread that is not last",
    ],
    [
      "export function f(n: number): number { return n <= 0 ? 0 : f(n - 1); }",
      "recursive in a way the subset does not take",
    ],
    [
      "export function f(xs: readonly number[]): number { if (xs.length === 0) return 0; return f(xs); }",
      "recursive in a way the subset does not take",
    ],
    ["export function f(x?: number): number { return 1; }", "optional parameter x"],
    ["export async function f(x: number): number { return x; }", "async function"],
    ["export function f(this: number, x: number): number { return x; }", "a this parameter"],
    ["export function f(x: number): number { throw new Error('x'); }", "throw"],
    ["export function f(x: number): number { return x as number; }", "the as operator"],
    ["export function f(x: number): number { return y; }", "y, which is neither"],
    [
      "export interface P { a?: number }\nexport function f(x: number): P { return {}; }",
      "type P is outside the subset: optional field a",
    ],
    ["export function f(x: number): number { return [x][0]; }", "without ?? fallback"],
  ])("outside the subset: %s", (source, reason) => {
    const m = readSubset(source);
    expect(m.functions).toEqual([]);
    expect(m.outside).toHaveLength(1);
    expect(m.outside[0]?.message).toContain(reason);
  });

  test("lists: types, literals, the methods the subset has, and structural recursion", () => {
    const m = readSubset(`
export function schedules(levels: readonly (readonly string[])[]): readonly (readonly number[])[] {
  if (levels.length === 0) return [[]];
  const rest = schedules(levels.slice(1));
  return (levels[0] ?? []).flatMap((_, i) => rest.map((s) => [i, ...s]));
}
export function count(levels: readonly (readonly string[])[]): number {
  return levels.reduce((n, options) => n * options.length, 1);
}
export function allSmall(xs: number[]): boolean {
  return xs.every((x) => x < 10) && !xs.some((x, i) => x === i);
}
`);
    expect(m.outside).toEqual([]);
    const [schedules, count, allSmall] = m.functions;
    expect(schedules).toMatchObject({ name: "schedules", structural: 0 });
    expect(schedules?.returns).toEqual({
      kind: "list",
      element: { kind: "list", element: { kind: "int" } },
    });
    expect(count).toMatchObject({ name: "count", returns: { kind: "int" } });
    expect(count?.structural).toBeUndefined();
    expect(allSmall?.params[0]?.type).toEqual({ kind: "list", element: { kind: "int" } });
  });

  test("?? binds looser than every other operator: only xs[0] alone may be its left operand", () => {
    const outside = (body: string) =>
      readSubset(`export function f(xs: readonly boolean[]): boolean { return ${body}; }`)
        .outside[0]?.message;
    expect(outside("false === xs[0] ?? false")).toContain("?? after anything but xs[0]");
    expect(outside("!xs[0] ?? false")).toContain("?? after anything but xs[0]");
    expect(outside("(xs[0] ?? false) ?? true")).toContain("?? after anything but xs[0]");
    const m = readSubset(
      "export function f(xs: readonly number[]): number { return xs[0] ?? 1 + 1; }\nexport function g(xs: readonly number[]): boolean { return false === (xs[0] ?? 0) > 0; }",
    );
    expect(m.outside).toEqual([]);
    // `xs[0] ?? 1 + 1` is `xs[0] ?? (1 + 1)`, as in JavaScript.
    expect(m.functions[0]?.body).toMatchObject({
      kind: "headOr",
      fallback: { kind: "binary", op: "+" },
    });
  });

  test("an engine that does not take lists drops their functions and keeps the rest; record rejection follows list elements", () => {
    const m = readSubset(`
export interface R { readonly x: number | null; readonly y: number }
export function lists(xs: readonly number[]): number { return xs.length; }
export function inside(n: number): number { return [n].length; }
export function plain(b: boolean): boolean { return b; }
export function ofRecords(rs: readonly R[]): boolean { return rs.every((r) => r.y > 0); }
`);
    const noLists = restrictModule(
      m,
      (t) => t.kind !== "list" && t.kind !== "nothing",
      "no lists",
      listKinds,
    );
    expect(noLists.functions.map((f) => f.name)).toEqual(["plain"]);
    const noNullable = restrictModule(m, (t) => t.kind !== "nullable", "no nullable");
    expect(noNullable.functions.map((f) => f.name)).not.toContain("ofRecords");
    // A union with a member the engine drops is dropped, and so is what uses it.
    const u = readSubset(`
export type Shape = { readonly kind: "dot" } | { readonly kind: "path"; readonly points: number[] };
export function kindOf(s: Shape): string { return s.kind; }
export function plain(b: boolean): boolean { return b; }
`);
    const noListsU = restrictModule(
      u,
      (t) => t.kind !== "list" && t.kind !== "nothing",
      "no lists",
      listKinds,
    );
    expect(noListsU.unions).toEqual([]);
    expect(noListsU.functions.map((f) => f.name)).toEqual(["plain"]);
    // Its other members stay records of their own (every record has its own sort), no longer naming it.
    const v = readSubset(`
export type V = { readonly kind: "a"; readonly n: number } | { readonly kind: "b"; readonly ps: number[] };
export interface A { readonly kind: "a"; readonly n: number }
export function nOf(a: A): number { return a.n; }
export function plain(b: boolean): boolean { return b; }
`);
    const noListsV = restrictModule(
      v,
      (t) => t.kind !== "list" && t.kind !== "nothing",
      "no lists",
      listKinds,
    );
    expect(noListsV.unions).toEqual([]);
    expect(noListsV.records.find((r) => r.name === "V.a")).toEqual({
      name: "V.a",
      fields: [
        { name: "kind", type: { kind: "string" }, literal: "a" },
        { name: "n", type: { kind: "int" } },
      ],
    });
    expect(noListsV.records.some((r) => r.unions?.includes("V"))).toBe(false);
    // A local annotation of a type the engine does not take puts its function outside too.
    const local = readSubset(
      "export function f(): number { const xs: (number | null)[] = []; return xs.length; }\nexport function g(b: boolean): boolean { return b; }",
    );
    expect(
      restrictModule(local, (t) => t.kind !== "nullable", "no nullable").functions.map(
        (f) => f.name,
      ),
    ).toEqual(["g"]);
    // An unannotated const holding an empty array of no type is refused at once.
    expect(
      readSubset("export function h(): number { const unused = []; return 1; }").outside[0]
        ?.message,
    ).toContain("annotate it");
  });

  test("xs[0] ?? d on a list of a nullable type is outside: ?? replaces a null head too", () => {
    const m = readSubset(
      "export function g(xs: readonly (number | null)[]): number | null { return xs[0] ?? 5; }",
    );
    expect(m.outside[0]?.message).toContain("list of a nullable type");
  });

  test("an engine that takes no unions keeps their members as records of their own", () => {
    const m = readSubset(`
export type S = { readonly kind: "a"; readonly n: number } | { readonly kind: "b" };
export function h(n: number): number { const v = { kind: "b" }; return n; }
`);
    const lean = restrictModule(m, (t) => t.kind !== "union", "no unions");
    expect(lean.records.map((r) => r.name).sort()).toEqual(["S.a", "S.b"]);
    expect(lean.functions.map((f) => f.name)).toEqual(["h"]);
  });

  test("a reduce callback's null check narrows, as in map", () => {
    const m = readSubset(
      "export function f(xs: readonly (number | null)[]): number { return xs.reduce((acc, x) => acc + (x === null ? 0 : x), 0); }",
    );
    expect(m.outside).toEqual([]);
  });

  test("mutual recursion stays outside, structural or not", () => {
    const m = readSubset(`
export function a(xs: readonly number[]): number { if (xs.length === 0) return 0; return b(xs.slice(1)); }
export function b(xs: readonly number[]): number { if (xs.length === 0) return 0; return a(xs.slice(1)); }
`);
    expect(m.functions).toEqual([]);
    expect(m.outside.map((o) => o.message).join("\n")).toContain("recursive in a way");
  });

  test("a module's own type named Array is its own, not the built-in", () => {
    const m = readSubset("type Array = number;\nexport function f(x: Array): number { return x; }");
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["f"]);
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
      "type P is outside the subset: field mk takes a name Lean's structures reserve",
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

  test("a function assigned anywhere in the module is not trusted, and neither are its callers", () => {
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
    expect(m.outside[0]?.message).toContain("is assigned in the module");
    // Every assignment form, in a block, a body or a template substitution, spelled with an escape too.
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
      "(<(x: number) => number>f) = (x: number): number => x + 1;",
      "if (true) { f = (x: number): number => x + 1; }",
      "export function g(x: number): number { f = g; return x; }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
      "const s = `${(f = (x: number): number => x + 1)}`;",
      "\\u0066 = (x: number): number => x + 1;",
    ]) {
      const m2 = readSubset(`export function f(x: number): number { return x; }\n${line}`);
      expect(
        m2.functions.map((fn) => fn.name),
        line,
      ).not.toContain("f");
    }
    // What runs under the name is still the declaration when it is called, aliased, passed on,
    // read, used as an object key, or when a local of the same name is assigned.
    const fine = readSubset(
      [
        "export function f(x: number): number { return x; }",
        "export function g(x: number): number { return f(x); }",
        "const o = { f: 1 }; o.f = 2; o?.f;",
        "const alias = f;",
        "[1].map(f);",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template literal on purpose
        "const s = `${f}`;",
        "const p = { f };",
        "function k(): void { let f = 1; f = 2; }",
      ].join("\n"),
    );
    expect(fine.functions.map((fn) => fn.name)).toEqual(["f", "g"]);
  });

  test("review findings on the compiler-backed reader: async callbacks, shorthand assignment targets, recursive arrays, contextual types kept", () => {
    // An async callback returns a promise, which is truthy: not the boolean the model computes.
    const asyncCb = readSubset(
      "export function f(xs: readonly number[]): boolean { return xs.some(async (x) => x > 0); }",
    );
    expect(asyncCb.outside[0]?.message).toContain("async");
    // A shorthand destructuring assignment writes the function's binding.
    const shorthand = readSubset(
      "export function f(x: number): number { return x; }\n({ f } = { f: (x: number): number => x + 1 });",
    );
    expect(shorthand.functions).toEqual([]);
    expect(shorthand.outside[0]?.message).toContain("is assigned in the module");
    // A type holding itself through an array is refused, not looped over.
    const recursive = readSubset(
      "export type R = R[];\nexport function f(x: R): number { return 0; }",
    );
    expect(recursive.outside[0]?.message).toContain("holds itself");
    // A literal in a callback: the compiler's context is the literal's own inferred type, which is
    // no declaration; the literal is matched against the declared records as before.
    const inferred = readSubset(
      "export interface A { n: number }\nexport function f(xs: readonly number[]): readonly A[] { return xs.map((n) => ({ n })); }",
    );
    expect(inferred.outside).toEqual([]);
    expect(inferred.records.map((r) => r.name)).toEqual(["A"]);
    // One inline type written twice is one record.
    const twice = readSubset("export function f(x: { n: number }): { n: number } { return x; }");
    expect(twice.outside).toEqual([]);
    expect(twice.records.map((r) => r.name)).toEqual(["{ n: number; }"]);
    // The context's type survives narrowing: a declared record and an inline one of the same shape.
    const same = readSubset(
      "export interface A { n: number }\nexport function f(x: number | null): A { if (x === null) return { n: 0 }; return { n: x }; }\nexport function g(): { n: number } { return { n: 0 }; }",
    );
    expect(same.outside).toEqual([]);
    expect(same.functions.map((fn) => [fn.name, fn.returns])).toEqual([
      ["f", { kind: "record", name: "A" }],
      ["g", { kind: "record", name: "{ n: number; }" }],
    ]);
    const body = same.functions[0]?.body;
    expect(body?.kind === "cond" && body.ifTrue.kind === "record" && body.ifTrue.type).toEqual({
      kind: "record",
      name: "A",
    });
    const renamed = renameVars(same.functions[0]?.body as Expr, new Map([["x", "y"]]));
    expect(
      renamed.kind === "cond" && renamed.ifTrue.kind === "record" && renamed.ifTrue.type,
    ).toEqual({
      kind: "record",
      name: "A",
    });
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

  test("source the compiler cannot parse puts every function outside, named or not", () => {
    const broken = readSubset(
      'export function f(x: number): number { return x; }\nconst s = "unterminated',
      ["g"],
    );
    expect(broken.functions).toEqual([]);
    expect(broken.outside).toEqual([
      { name: "f", line: 0, message: expect.stringContaining("could not be parsed") },
      { name: "g", line: 0, message: expect.stringContaining("could not be parsed") },
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
    // A and C have the same fields; the declared return type tells a's literal from two's.
    expect(m.functions.map((fn) => fn.name)).toEqual(["a", "b", "two"]);
    expect(m.functions.map((fn) => fn.returns)).toEqual([
      { kind: "record", name: "A" },
      { kind: "record", name: "B" },
      { kind: "record", name: "C" },
    ]);
    // { v: x > 0 } is typed against its context, A, whose field v is a number.
    expect(m.outside.find((o) => o.name === "wrong")?.message).toBe(
      "field v of a A literal holds a bool, not a int",
    );
    // Without a context, a literal of fields two records share is ambiguous.
    const bare = readSubset(
      "export interface A { v: number }\nexport interface C { v: number }\nexport function f(x: number): number { const r = { v: x }; return r.v; }",
    );
    expect(bare.outside[0]?.message).toContain("matches A and C alike");
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

  test("a const arrow is a function as a declaration is: expression or block body, called and calling", () => {
    const src = `
export interface Window { readonly index: number; readonly endsAt: number }
export const twice = (n: number): number => n + n;
export const window = (i: number): Window => ({ index: i, endsAt: twice(i) + 1 });
export const clamp = (n: number): number => {
  if (n < 0) return 0;
  return n;
};
export function viaArrow(n: number): number { return clamp(twice(n)); }
`;
    const m = readSubset(src);
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["twice", "window", "clamp", "viaArrow"]);
    const w = m.functions.find((f) => f.name === "window");
    expect(w?.returns).toEqual({ kind: "record", name: "Window" });
    expect(w?.body).toMatchObject({
      kind: "record",
      fields: [{ name: "index" }, { name: "endsAt" }],
    });
    // The identity the spec reader records: the offset of the arrow's own `(`.
    expect(w?.offset).toBe(src.indexOf("(i: number)"));
    expect(m.functions.find((f) => f.name === "clamp")?.body.kind).toBe("cond");
  });

  test("an arrow that may be rebound, or is no arrow, is outside with why; so are its callers", () => {
    const m = readSubset(`
export let rebindable = (n: number): number => n;
export const viaLet = (n: number): number => rebindable(n);
export const expression = function (n: number): number { return n; };
export const untyped = (n: number) => n;
export const twoAtOnce = (n: number): number => n, other = (n: number): number => n;
`);
    expect(m.functions.map((f) => f.name)).toEqual(["twoAtOnce", "other"]);
    const why = Object.fromEntries(m.outside.map((o) => [o.name, o.message]));
    expect(why["rebindable"]).toMatch(/declared with let/);
    expect(why["viaLet"]).toMatch(/calls rebindable/);
    expect(why["expression"]).toMatch(/function expression/);
    expect(why["untyped"]).toMatch(/without a return type/);
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

describe("nullable types and tagged unions", () => {
  const source = `
export interface Challenge { readonly attempts: number; readonly locked: boolean }
export type Refused = { readonly type: "invalid_code" } | { readonly type: "code_locked" };
export type Outcome = { readonly ok: true; readonly value: Challenge } | { readonly ok: false; readonly error: Refused };
export type Status = "invited" | "active" | "disabled";
export type MaybeChallenge = Challenge | null;

export function admit(c: Challenge | null, matches: boolean): Outcome {
  if (c === null) return { ok: false, error: { type: "invalid_code" } };
  if (c.locked) return { ok: false, error: { type: "code_locked" } };
  if (!matches) return { ok: false, error: { type: "invalid_code" } };
  return { ok: true, value: c };
}
export function decideAccess(status: Status | null): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}
export function attempts(c: MaybeChallenge): number {
  return c !== null && !c.locked ? c.attempts : 0;
}
export function okOf(o: Outcome): boolean { return o.ok; }
export function wrong(c: Challenge | null): number { return c.attempts; }
export function valueOf(o: Outcome): Challenge { return o.value; }
export function compare(a: Challenge | null, b: Challenge | null): boolean { return a === b; }
`;
  const module = readSubset(source);
  const outside = Object.fromEntries(module.outside.map((o) => [o.name, o.message]));

  test("declarations: nullable parameters, aliases, unions with their tags and members named by tag", () => {
    expect(module.unions).toEqual([
      {
        name: "Refused",
        tag: "type",
        members: [
          { tag: "invalid_code", record: "Refused.invalid_code" },
          { tag: "code_locked", record: "Refused.code_locked" },
        ],
      },
      {
        name: "Outcome",
        tag: "ok",
        members: [
          { tag: true, record: "Outcome.true" },
          { tag: false, record: "Outcome.false" },
        ],
      },
    ]);
    expect(module.records.find((r) => r.name === "Outcome.false")).toEqual({
      name: "Outcome.false",
      fields: [
        { name: "ok", type: { kind: "bool" }, literal: false },
        { name: "error", type: { kind: "union", name: "Refused" } },
      ],
      unions: ["Outcome"],
    });
    const admit = module.functions.find((f) => f.name === "admit");
    expect(admit?.params[0]?.type).toEqual({
      kind: "nullable",
      inner: { kind: "record", name: "Challenge" },
    });
    expect(admit?.returns).toEqual({ kind: "union", name: "Outcome" });
    expect(module.functions.find((f) => f.name === "decideAccess")?.params[0]?.type).toEqual({
      kind: "nullable",
      inner: { kind: "string" },
    });
    expect(module.functions.find((f) => f.name === "attempts")?.params[0]?.type).toEqual({
      kind: "nullable",
      inner: { kind: "record", name: "Challenge" },
    });
  });

  test("a null check narrows the name it guards, in the branch it guards and in the right operand of && and ||", () => {
    const admit = module.functions.find((f) => f.name === "admit");
    // `if (c === null) return …; rest`: in rest, c is narrowed.
    expect(admit?.body).toMatchObject({ kind: "cond", ifFalse: { kind: "narrow", name: "c" } });
    const attempts = module.functions.find((f) => f.name === "attempts");
    expect(attempts?.body).toMatchObject({
      kind: "cond",
      test: { kind: "binary", op: "&&", right: { kind: "narrow", name: "c" } },
      ifTrue: { kind: "narrow", name: "c" },
    });
  });

  test("the tag of a union is read from every member; other fields and unguarded reads are outside", () => {
    expect(module.functions.map((f) => f.name)).toContain("okOf");
    expect(outside["wrong"]).toContain("compare it with null first, which narrows it");
    expect(outside["valueOf"]).toContain("not on every member of Outcome");
    expect(outside["compare"]).toContain("compares references");
  });

  test("a record literal picks its union member by the tag; a member stands where its union is expected", () => {
    const admit = module.functions.find((f) => f.name === "admit");
    expect(admit?.body).toMatchObject({
      ifTrue: { kind: "record", fields: [{ name: "ok" }, { name: "error" }] },
    });
  });

  test("a union of records without a tag, or mixed with other types, is outside with why", () => {
    const m = readSubset(`
export type NoTag = { readonly a: number } | { readonly b: number };
export type Mixed = { readonly a: number } | number;
export function f(x: NoTag): number { return 1; }
export function g(x: Mixed): number { return 1; }
`);
    expect(m.outside.find((o) => o.name === "f")?.message).toContain("without a tag");
    expect(m.outside.find((o) => o.name === "g")?.message).toContain(
      "mixing records with other types",
    );
  });

  test("restrictModule drops what an engine does not take, and the callers of what it drops", () => {
    const restricted = restrictModule(
      module,
      (t) => t.kind === "int" || t.kind === "bool" || t.kind === "string" || t.kind === "record",
      "not taken",
    );
    expect(restricted.functions.map((f) => f.name)).toEqual([]);
    expect(restricted.outside.find((o) => o.name === "admit")?.message).toBe("not taken");
    expect(restricted.unions).toEqual([]);
    const plain = readSubset(
      "export function f(x: number): number { return x; }\nexport function g(x: number): number { return f(x); }",
    );
    expect(restrictModule(plain, () => true, "never").functions.map((f) => f.name)).toEqual([
      "f",
      "g",
    ]);
  });
});

describe("nullable types and tagged unions, after review", () => {
  test("an initializer under a null check is typed as the check allows; an annotation is the binding's type", () => {
    const m = readSubset(`
export interface C { readonly n: number }
export function guarded(x: number | null): number {
  const y = x === null ? 0 : x + 1;
  return y;
}
export function early(c: C | null): number {
  if (c === null) return 0;
  const n = c.n;
  return n;
}
export function annotated(x: number): number {
  const c: C | null = null;
  return c === null ? x : c.n;
}
export function wrongAnnotation(x: number): number {
  const c: C = null;
  return x;
}
`);
    expect(m.functions.map((f) => f.name)).toEqual(["guarded", "early", "annotated"]);
    expect(m.functions.find((f) => f.name === "annotated")?.body).toMatchObject({
      kind: "let",
      name: "c",
      type: { kind: "nullable", inner: { kind: "record", name: "C" } },
    });
    expect(m.outside.find((o) => o.name === "wrongAnnotation")?.message).toContain(
      "annotated C but holds a null",
    );
  });

  test("a field typed with a union of literals is no tag; a record may be in two unions", () => {
    const m = readSubset(`
export type Ev = { readonly kind: "a" | "b"; readonly x: number } | { readonly kind: "c"; readonly y: number };
export interface A { readonly t: "a" }
export interface B { readonly t: "b" }
export interface Cc { readonly t: "c" }
export type U1 = A | B;
export type U2 = A | Cc;
export function f(e: Ev): number { return 1; }
export function g(x: boolean): U2 { return x ? { t: "a" } : { t: "c" }; }
`);
    expect(m.outside.find((o) => o.name === "f")?.message).toContain("without a tag");
    expect(m.unions.map((u) => u.name)).toEqual(["U1", "U2"]);
    expect(m.records.find((r) => r.name === "A")?.unions).toEqual(["U1", "U2"]);
    expect(m.functions.map((f) => f.name)).toContain("g");
  });
});

describe("records in several unions, after review", () => {
  test("a conditional over members of several unions takes the declared type where it stands", () => {
    const m = readSubset(`
export interface A { readonly tag: "a" }
export interface B { readonly tag: "b" }
export interface C { readonly tag: "c" }
export type U1 = A | B;
export type U2 = A | B | C;
export function choose(b: boolean): U1 { return b ? { tag: "a" } : { tag: "b" }; }
export function bound(b: boolean, a: A, bb: B): U1 {
  const r: U1 = b ? a : bb;
  return r;
}
export function wide(b: boolean, a: A, bb: B): U2 { return b ? a : bb; }
`);
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["choose", "bound", "wide"]);
  });
});

describe("narrowing by a union's tag", () => {
  const module = `
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export interface Locked { readonly type: "locked"; readonly until: number }
export type Decision = { readonly kind: "allow"; readonly remaining: number } | { readonly kind: "deny" } | { readonly kind: "defer"; readonly until: number };
export function valueOr(r: Result<number, Locked>, fallback: number): number {
  if (r.ok) return r.value;
  return r.error.until + fallback;
}
export function remaining(d: Decision): number {
  return d.kind === "allow" ? d.remaining : 0;
}
export function nonNegative(d: Decision): boolean {
  return d.kind !== "allow" || d.remaining >= 0;
}
export function flipped(r: Result<number, Locked>): number {
  if (!r.ok) return r.error.until;
  return r.value;
}
export function orBoth(r: Result<number, Locked>, d: Decision): number {
  if (r.ok && d.kind === "allow") return r.value + d.remaining;
  return 0;
}
export function twoOfThree(d: Decision): number {
  if (d.kind !== "allow") return d.until;
  return d.remaining;
}
`;
  const m = readSubset(module);

  test("a tag test narrows the name it guards to the member with that tag, in the branch it guards", () => {
    expect(m.outside.map((o) => o.name)).toEqual(["twoOfThree"]);
    expect(m.outside[0]?.message).toContain("not on every member");
    const valueOr = m.functions.find((f) => f.name === "valueOr")?.body;
    expect(valueOr).toEqual({
      kind: "cond",
      test: { kind: "field", object: { kind: "var", name: "r" }, field: "ok" },
      ifTrue: {
        kind: "narrowTag",
        name: "r",
        member: "Result<number, Locked>.true",
        body: { kind: "field", object: { kind: "var", name: "r" }, field: "value" },
      },
      ifFalse: {
        kind: "narrowTag",
        name: "r",
        member: "Result<number, Locked>.false",
        body: {
          kind: "binary",
          op: "+",
          left: {
            kind: "field",
            object: { kind: "field", object: { kind: "var", name: "r" }, field: "error" },
            field: "until",
          },
          right: { kind: "var", name: "fallback" },
        },
      },
    });
    const remaining = m.functions.find((f) => f.name === "remaining")?.body;
    expect(remaining?.kind === "cond" && remaining.ifTrue).toMatchObject({
      kind: "narrowTag",
      name: "d",
      member: "Decision.allow",
    });
    // Three members: the failing branch of `=== "allow"` is no single member, so nothing is narrowed there.
    expect(remaining?.kind === "cond" && remaining.ifFalse).toEqual({ kind: "int", value: "0" });
    const nonNegative = m.functions.find((f) => f.name === "nonNegative")?.body;
    expect(nonNegative?.kind === "binary" && nonNegative.right).toMatchObject({
      kind: "narrowTag",
      member: "Decision.allow",
    });
    // Two null checks joined by && narrow both names in the guarded branch.
    const both = readSubset(
      "export function f(x: number | null, y: number | null): number { if (x !== null && y !== null) return x + y; return 0; }",
    );
    expect(both.outside).toEqual([]);
    const orBoth = m.functions.find((f) => f.name === "orBoth")?.body;
    expect(orBoth?.kind === "cond" && orBoth.ifTrue).toMatchObject({
      kind: "narrowTag",
      name: "r",
      body: { kind: "narrowTag", name: "d", member: "Decision.allow" },
    });
  });

  test("two narrowed members, each nullable, join into their nullable union", () => {
    const m2 = readSubset(`
export type U = { readonly ok: true; readonly n: number } | { readonly ok: false; readonly n: number };
export function f(u: U, b: boolean): U | null { return u.ok ? (b ? u : null) : (b ? u : null); }
`);
    expect(m2.outside).toEqual([]);
  });

  test("a spec arrow's tag test narrows too, and renaming keeps the narrowed name", () => {
    const scope = new Map<string, SubsetType>([
      ["r", { kind: "union", name: "Result<number, Locked>" }],
    ]);
    const read = readArrowBody(
      { params: ["r"], body: "r.ok ? r.value >= 0 : r.error.until >= 0", block: false, line: 1 },
      scope,
      m,
      new Map([["valueOr", "valueOr"]]),
    );
    expect(read).toMatchObject({
      kind: "cond",
      ifTrue: { kind: "narrowTag", name: "r", member: "Result<number, Locked>.true" },
    });
    const renamed = renameVars(read, new Map([["r", "res"]]));
    expect(renamed).toMatchObject({
      ifTrue: {
        kind: "narrowTag",
        name: "res",
        body: { left: { object: { kind: "var", name: "res" } } },
      },
    });
    expect(
      typeOf(
        renamed,
        new Map([["res", { kind: "union", name: "Result<number, Locked>" }]]),
        {
          records: new Map(m.records.map((r) => [r.name, r])),
          signatures: new Map(),
        },
        (msg) => {
          throw new Error(msg);
        },
      ),
    ).toEqual({ kind: "bool" });
  });
});

/** The module read beside other files, all held in memory under one directory. */
function readWith(files: Record<string, string>, module: string): ReturnType<typeof readSubset> {
  return readSubset(module, undefined, {
    path: "/virtual/domain.ts",
    files: Object.entries(files).map(([name, text]) => ({ path: `/virtual/${name}`, text })),
  });
}

const kit = `
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
const twice = (n: number): number => n + n;
export const doubled = (n: number): number => twice(n);
`;

/** The calls an expression still makes, by callee, at any depth. */
function callsIn(e: Expr, out: string[] = []): string[] {
  if (e.kind === "call") out.push(e.callee);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v && typeof v === "object") {
      if ("kind" in v) callsIn(v as Expr, out);
      else for (const x of Object.values(v)) visit(x);
    }
  };
  for (const [k, v] of Object.entries(e)) if (k !== "type") visit(v);
  return out;
}

describe("generic and imported functions, inlined at the call", () => {
  test("a generic helper of the module is inlined where it is called, at the call's instantiation", () => {
    const m = readSubset(`${kit}
export interface Locked { readonly type: "locked"; readonly until: number }
export const judge = (attempts: number, matches: boolean): Result<number, Locked> => {
  if (!matches) return err<Locked>({ type: "locked", until: attempts + 1 });
  return ok(attempts);
};
`);
    expect(m.functions.map((f) => f.name)).toContain("judge");
    const judge = m.functions.find((f) => f.name === "judge");
    expect(callsIn(judge?.body as Expr)).toEqual([]);
    // The helpers themselves are generic: no engine states a claim over a type parameter.
    const why = Object.fromEntries(m.outside.map((o) => [o.name, o.message]));
    expect(why["ok"]).toMatch(/type parameters/);
    expect(why["judge"]).toBeUndefined();
  });

  test("a function imported from another file is inlined, with its own module's helpers", () => {
    const m = readWith(
      { "kit.ts": kit },
      `import { type Result, ok, err, doubled } from "./kit.ts";
export const grow = (n: number): Result<number, string> =>
  n < 0 ? err("negative") : ok(doubled(n));
`,
    );
    expect(m.outside).toEqual([]);
    const grow = m.functions.find((f) => f.name === "grow");
    expect(callsIn(grow?.body as Expr)).toEqual([]);
  });

  test("an inlined body's names never capture the caller's", () => {
    const m = readWith(
      { "kit.ts": kit },
      `import { doubled } from "./kit.ts";
export const shift = (n: number, twice: number): number => {
  const value = doubled(twice + n);
  return value + twice;
};
`,
    );
    expect(m.outside).toEqual([]);
    const body = m.functions.find((f) => f.name === "shift")?.body as Expr;
    // The caller's own names stay bound once each: the inlined lets were renamed away from them.
    const lets: string[] = [];
    const walk = (e: Expr): void => {
      if (e.kind === "let") lets.push(e.name);
      for (const v of Object.values(e))
        if (v && typeof v === "object" && "kind" in v) walk(v as Expr);
    };
    walk(body);
    expect(lets.filter((n) => n === "twice" || n === "n")).toEqual([]);
    expect(new Set(lets).size).toBe(lets.length);
  });

  test("review: an unused parameter's name is never reused for another's fresh name", () => {
    const m = readWith(
      { "kit.ts": "export const first = (a: number, a_: number): number => a;\n" },
      `import { first } from "./kit.ts";
export const pick = (a: number): number => first(1, 2);
`,
    );
    const body = m.functions.find((f) => f.name === "pick")?.body as Expr;
    const lets: string[] = [];
    const walk = (e: Expr): void => {
      if (e.kind === "let") lets.push(e.name);
      for (const v of Object.values(e))
        if (v && typeof v === "object" && "kind" in v) walk(v as Expr);
    };
    walk(body);
    expect(new Set(lets).size).toBe(lets.length);
    // The first parameter's value is what the body returns.
    expect(body).toMatchObject({ kind: "let", value: { kind: "int", value: "1" } });
    const firstName = (body as Extract<Expr, { kind: "let" }>).name;
    let inner: Expr = body;
    while (inner.kind === "let") inner = inner.body;
    expect(inner).toEqual({ kind: "var", name: firstName });
  });

  test("review: a generic helper calling another is read at the outer call's types", () => {
    const m = readWith(
      {
        "kit.ts": `export const id = <T>(x: T): T => x;
export const wrap = <T>(x: T): T => id(x);
`,
      },
      `import { wrap } from "./kit.ts";
export const same = (n: number): number => wrap(n);
`,
    );
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["same"]);
  });

  test("review: callsIn sees calls at any depth", () => {
    const m = readSubset(`
export const inc = (n: number): number => n + 1;
export const f = (n: number): number => {
  const a = n > 0 ? inc(n) : 0;
  return a;
};
`);
    expect(callsIn(m.functions.find((f) => f.name === "f")?.body as Expr)).toEqual(["inc"]);
  });

  test("review: a call the compiler rejects is not read (a type-only import does not exist at run time)", () => {
    const m = readWith(
      { "kit.ts": kit },
      `import type { ok, Ok } from "./kit.ts";
export const f = (n: number): Ok<number> => ok(n);
`,
    );
    expect(m.functions).toEqual([]);
    expect(m.outside.find((o) => o.name === "f")?.message).toMatch(/compiler reports an error/);
  });

  test("review: a default-exported function is found by its declaration", () => {
    const m = readWith(
      { "twice.ts": "export default function twice(n: number): number { return n + n; }\n" },
      `import twice from "./twice.ts";
export const four = (n: number): number => twice(twice(n));
`,
    );
    expect(m.outside).toEqual([]);
    expect(m.functions.map((f) => f.name)).toEqual(["four"]);
  });

  test("what cannot be inlined is outside with why: no body, recursion, a rebindable binding", () => {
    const m = readWith(
      {
        "kit.ts": `export let loose = (n: number): number => n;
export const loop = (n: number): number => (n > 0 ? loop(n - 1) : 0);
`,
        "decl.d.ts": "export declare function hidden(n: number): number;",
      },
      `import { loose, loop } from "./kit.ts";
import { hidden } from "./decl";
export const a = (n: number): number => loose(n);
export const b = (n: number): number => loop(n);
export const c = (n: number): number => hidden(n);
`,
    );
    const why = Object.fromEntries(m.outside.map((o) => [o.name, o.message]));
    expect(why["a"]).toMatch(/let or var/);
    expect(why["b"]).toMatch(/recursi/);
    expect(why["c"]).toMatch(/no body|declaration file/);
    expect(m.functions).toEqual([]);
  });
});
