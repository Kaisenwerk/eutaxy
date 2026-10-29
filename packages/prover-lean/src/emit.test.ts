import { readSpecs, readSubset } from "@eutaxy/prover/reader";
import type { Property } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { emitModule, ident, statement, value } from "./emit.ts";

const source = `
export interface Decision { readonly ok: boolean; readonly left: number }
export function take(balance: number, amount: number): Decision {
  const fits = amount <= balance;
  return fits ? { ok: true, left: balance - amount } : { ok: false, left: balance };
}
export function tag(n: number, s: string): string { return s; }
`;
const specSource = `
import { forall } from "eutaxy/spec";
import { tag, take } from "./domain.ts";
export const a = forall(take, {
  when: (balance, amount) => 0 <= balance && 0 <= amount && amount < 1_000,
  ensures: (balance, amount) => take(balance, amount).left >= 0,
});
export const b = forall(take, { ensures: (balance, amount) => take(balance, amount).ok === (amount <= balance) });
export const c = forall(take, { when: (b, a) => Number.isInteger(a), ensures: (x, y) => take(x, y).left >= 0 || y < x });
export const d = forall(take, { ensures: (balance) => take(balance, 1) === take(balance, 1) });
export const f = forall(take, { ensures: (balance) => take(balance, 1).left });
export const g = forall(take, { ensures: (balance) => { const d = take(balance, 1); return d.left <= balance; } });
export const h = forall(tag, { when: (n, s) => /^a+$/.test(s), ensures: (n, s) => tag(n, s) === s });
export const i = forall(tag, { ensures: (n, s) => tag(n, s) === s });
`;
const module = readSubset(source);
const specs = readSpecs({ module: source, spec: specSource, modulePath: "/virtual/domain.ts" });
const prop = (name: string): Property => {
  const p = specs.functions.flatMap((f) => f.properties).find((x) => x.name === name);
  if (!p) throw new Error(`no property ${name}`);
  return p;
};

describe("statement", () => {
  test("binders from the parameters, the precondition as a hypothesis, then the claim", () => {
    expect(specs.errors).toEqual([]);
    expect(statement(prop("a"), module)).toBe(
      [
        "∀ (v_balance : Int) (v_amount : Int),",
        "    ((((decide ((0 : Int) ≤ v_balance)) && (decide ((0 : Int) ≤ v_amount))) && (decide (v_amount < (1000 : Int)))) = true) →",
        "    ((decide ((f_take v_balance v_amount).left ≥ (0 : Int))) = true)",
      ].join("\n"),
    );
  });

  test("equality of booleans; the arrows' own parameter names are renamed to the binders'", () => {
    expect(statement(prop("b"), module)).toContain(
      "((decide ((f_take v_balance v_amount).ok = (decide (v_amount ≤ v_balance)))) = true)",
    );
    // `when` names them (b, a) and `ensures` (x, y): the binders are x and y, and Number.isInteger is true of an Int.
    expect(statement(prop("c"), module)).toBe(
      [
        "∀ (v_x : Int) (v_y : Int),",
        "    (true = true) →",
        "    (((decide ((f_take v_x v_y).left ≥ (0 : Int))) || (decide (v_y < v_x))) = true)",
      ].join("\n"),
    );
  });

  test("a block body reads through the statement reader", () => {
    expect(statement(prop("g"), module)).toContain(
      "((let v_d := (f_take v_balance (1 : Int)); (decide (v_d.left ≤ v_balance))) = true)",
    );
  });

  test("=== on records, a non-boolean claim and a regex precondition are outside the engine", () => {
    expect(() => statement(prop("d"), module)).toThrow("compares references");
    expect(() => statement(prop("f"), module)).toThrow("is not boolean");
    expect(() => statement(prop("h"), module)).toThrow("regular expression");
  });
});

describe("emitModule", () => {
  test("structures, definitions with let and conditionals, one theorem per statable property, lines mapped", () => {
    const all = specs.functions.flatMap((fn) =>
      fn.properties.map((property) => ({ function: fn.name, property })),
    );
    const emitted = emitModule(module, all, [
      "example : f_take 5 3 = ({ ok := true, left := 2 } : R_Decision) := by decide",
    ]);
    expect(emitted.source).toContain(
      "structure R_Decision where\n  ok : Bool\n  left : Int\n  deriving Repr, DecidableEq",
    );
    expect(emitted.source).toContain(
      "def f_take (v_balance : Int) (v_amount : Int) : R_Decision :=\n  (let v_fits := (decide (v_amount ≤ v_balance)); (if v_fits = true then ({ ok := true, left := (v_balance - v_amount) } : R_Decision) else ({ ok := false, left := v_balance } : R_Decision)))",
    );
    expect(emitted.theorems.map((t) => t.property)).toEqual(["a", "b", "c", "g", "i"]);
    expect(emitted.skipped.map((s) => s.property)).toEqual(["d", "f", "h"]);
    const lines = emitted.source.split("\n");
    for (const t of emitted.theorems) {
      expect(lines[t.from - 1]).toBe(`theorem ${t.name} :`);
      expect(lines[t.to - 1]).toBe("  all_goals (first | decide | trivial | omega)");
    }
    expect(emitted.source.trimEnd().endsWith(":= by decide")).toBe(true);
  });
});

describe("theorem names", () => {
  test("properties whose names differ only in punctuation get distinct theorems", () => {
    const src = "export function f(x: number): number { return x; }";
    const sp = readSpecs({
      module: src,
      spec: 'import { forall } from "eutaxy/spec";\nimport { f } from "./m.ts";\nexport const a$b = forall(f, { ensures: (x) => f(x) === x });\nexport const a_b = forall(f, { ensures: (x) => f(x) === x });',
      modulePath: "/virtual/m.ts",
    });
    const emitted = emitModule(
      readSubset(src),
      (sp.functions[0]?.properties ?? []).map((property) => ({ function: "f", property })),
    );
    const names = emitted.theorems.map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["t0_f_a_b", "t1_f_a_b"]);
  });
});

describe("term", () => {
  test("a comparison passed as an argument stays one argument", () => {
    const m = readSubset(
      "export function g(b: boolean): number { return b ? 1 : 0; }\nexport function f(x: number): number { return g(x > 0); }",
    );
    const emitted = emitModule(m, []);
    expect(emitted.source).toContain(
      "def f_f (v_x : Int) : Int :=\n  (f_g (decide (v_x > (0 : Int))))",
    );
  });
});

describe("ident and value", () => {
  test("every TypeScript name gets a shape Lean's prelude never uses, disjoint per kind; odd spellings are quoted", () => {
    expect(ident.fn("decide")).toBe("f_decide");
    expect(ident.record("Decision")).toBe("R_Decision");
    expect(ident.variable("max")).toBe("v_max");
    expect(ident.field("ok")).toBe("ok");
    expect(ident.field("end")).toBe("«end»");
    expect(ident.field("from")).toBe("«from»");
    expect(ident.fn("a$b")).toBe("«f_a$b»");
    expect(ident.variable("λ")).toBe("«v_λ»");
    // A parameter spelled like a prefixed function cannot shadow that function.
    expect(ident.variable("f_x")).not.toBe(ident.fn("x"));
    expect(ident.variable("ts_f")).not.toBe(ident.fn("f_"));
  });

  test("TypeScript values as Lean terms of their type", () => {
    expect(value(-3, { kind: "int" }, module)).toBe("(-3 : Int)");
    expect(value(true, { kind: "bool" }, module)).toBe("true");
    expect(value({ ok: false, left: 7 }, { kind: "record", name: "Decision" }, module)).toBe(
      "({ ok := false, left := (7 : Int) } : R_Decision)",
    );
    expect(() => value(1.5, { kind: "int" }, module)).toThrow("not an integer");
    expect(() =>
      value({ ok: true, left: 1, extra: 2 }, { kind: "record", name: "Decision" }, module),
    ).toThrow("unexpected fields extra");
  });
});

describe("review findings", () => {
  const read = (spec: string) =>
    readSpecs({ module: source, spec, modulePath: "/virtual/domain.ts" }).functions.flatMap(
      (f) => f.properties,
    );

  test("a claim's names are the spec file's imports: an alias resolves to the function, a local helper is outside", () => {
    const [aliased, local] = read(`
import { forall } from "eutaxy/spec";
import { take as t } from "./domain.ts";
const take = (balance: number, amount: number) => ({ ok: true, left: 0 });
export const aliased = forall(t, { ensures: (b, a) => t(b, a).left <= b || a < 0 });
export const local = forall(t, { ensures: (b, a) => take(b, a).left <= b });
`);
    if (!aliased || !local) throw new Error("fixtures");
    expect(statement(aliased, module)).toContain("(f_take v_b v_a).left");
    expect(() => statement(local, module)).toThrow(
      "ensures (spec file line 6): take, which is neither a parameter, a const nor a function imported from the module beside the spec file",
    );
  });

  test("renaming an arrow's parameters never lets a local const capture them", () => {
    const [p] = read(`
import { forall } from "eutaxy/spec";
import { take } from "./domain.ts";
export const p = forall(take, {
  when: (x) => { const a = 0; return x !== a; },
  ensures: (a, b) => take(a, b).left === a || a === 0,
});
`);
    if (!p) throw new Error("fixture");
    expect(statement(p, module)).toContain(
      "((let v_a_ := (0 : Int); (decide (v_a ≠ v_a_))) = true) →",
    );
  });

  test("what the subset refuses in an arrow is located in the spec file", () => {
    const [p] = read(`
import { forall } from "eutaxy/spec";
import { take } from "./domain.ts";
export const p = forall(take, {
  ensures: (b, a) => { let n = 0; return take(b, a).left >= n; },
});
`);
    if (!p) throw new Error("fixture");
    expect(() => statement(p, module)).toThrow(
      "ensures (spec file line 5): a mutable binding (use const)",
    );
  });
});

describe("review findings, second round", () => {
  const read = (spec: string) =>
    readSpecs({ module: source, spec, modulePath: "/virtual/domain.ts" }).functions.flatMap(
      (f) => f.properties,
    );

  test("a fresh name for a captured let avoids every name the arrow already uses", () => {
    const [p] = read(`
import { forall } from "eutaxy/spec";
import { take } from "./domain.ts";
export const p = forall(take, {
  when: (x) => { const y_ = 0; const y = 1; return x === y_; },
  ensures: (y) => y === 1,
});
`);
    if (!p) throw new Error("fixture");
    const text = statement(p, module);
    expect(text).toContain(
      "(let v_y_ := (0 : Int); (let v_y__ := (1 : Int); (decide (v_y = v_y_))))",
    );
  });

  test("a function of no parameters is stated without a quantifier and proved without intro", () => {
    const src = "export function one(): number { return 1; }";
    const specs = readSpecs({
      module: src,
      spec: 'import { forall } from "eutaxy/spec";\nimport { one } from "./m.ts";\nexport const isOne = forall(one, { ensures: () => one() === 1 });',
      modulePath: "/virtual/m.ts",
    });
    const m = readSubset(src);
    const emitted = emitModule(
      m,
      (specs.functions[0]?.properties ?? []).map((property) => ({ function: "one", property })),
    );
    expect(emitted.source).toContain(
      "theorem t0_one_isOne :\n    ((decide ((f_one) = (1 : Int))) = true) := by\n  all_goals",
    );
    expect(emitted.source).not.toContain("∀ ,");
    expect(emitted.source).not.toContain("intro \n");
  });
});

describe("lists, review findings", () => {
  test("an annotated empty list keeps its element type in Lean", () => {
    const m = readSubset(
      "export function f(): number { const xs: number[] = []; return xs.length; }",
    );
    expect(emitModule(m, []).source).toContain("let v_xs : (List Int) := []");
    // The annotation types the binding in the emitter's own scope too: reduce's item is a number.
    const folded = readSubset(
      "export function g(): number { const xs: number[] = []; return xs.reduce((acc, x) => acc + x, 0); }",
    );
    expect(() => emitModule(folded, [])).not.toThrow();
  });

  test("an operation on an empty array of no declared type is refused, never typed by a guess", () => {
    for (const body of ["[].length", "[].slice(1)", "[][0] ?? 0", "[[]].length"]) {
      const m = readSubset(`export function f(): number { return ${body}; }`);
      expect(m.outside[0]?.message, body).toContain("empty array of no declared type");
    }
  });

  test("generated names are quoted whole: an index or a recursed list named with $", () => {
    const m = readSubset(`
export function f(xs: readonly number[]): readonly number[] { return xs.map((x, i$) => i$); }
export function g($xs: readonly number[]): number { if ($xs.length === 0) return 0; return g($xs.slice(1)); }
`);
    const lean = emitModule(m, []).source;
    expect(lean).toContain("«nv_i$»");
    expect(lean).toContain("| «vh_$xs» :: «vt_$xs» =>");
  });
});

describe("identifiers", () => {
  test("names Lean cannot spell are quoted injectively: guillemets and % never meet", () => {
    expect(ident.record("Plain")).toBe("R_Plain");
    expect(ident.record("a»b")).not.toBe(ident.record("a%bbb"));
    expect(ident.record("a«b")).not.toBe(ident.record("a%abb"));
    expect(ident.record("a»b")).not.toContain("»b");
  });
});
