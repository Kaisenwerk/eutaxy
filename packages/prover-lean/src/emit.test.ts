import { extractSpecs, type FunctionSpec } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { emitModule, ident, statement, value } from "./emit.ts";
import { readSubset } from "./subset.ts";

const source = `
export interface Decision { readonly ok: boolean; readonly left: number }
/**
 * @ensures{a} forall (balance: nat) (amount: int ∈ [0, 1_000)) { take(balance, amount).left >= 0 }
 * @ensures{b} forall (balance amount: int) { take(balance, amount).ok ↔ amount <= balance }
 * @ensures{c} forall (x: number) { take(x, 1).left >= 0 }
 * @ensures{d} forall (balance: int) { take(balance, 1) ≡ take(balance, 1) }
 * @ensures{e} forall (balance: int) { take(balance, 1).left ≢ take(balance, 2).ok }
 * @ensures{f} forall (balance: int) { take(balance, 1).left }
 * @ensures{g} forall (balance: int) { take(balance, 1).left ≡ balance - 1 }
 * @ensures{h} forall (balance: int) { take(balance, 1).ok ≡ (1 <= balance) }
 * @ensures{i} forall (balance: bigint) { take(balance, 1).left >= 0 }
 */
export function take(balance: number, amount: number): Decision {
  const fits = amount <= balance;
  return fits ? { ok: true, left: balance - amount } : { ok: false, left: balance };
}
`;
const module = readSubset(source);
const fn = extractSpecs(source).functions[0] as FunctionSpec;
const prop = (name: string) => fn.ensures.find((p) => p.name === name)?.property;

describe("statement", () => {
  test("binders, their domains and guards, preconditions, then the claim", () => {
    const p = prop("a");
    expect(p).toBeDefined();
    if (!p) return;
    expect(statement(p, module)).toBe(
      [
        "∀ (v_balance : Int) (v_amount : Int),",
        "    0 ≤ v_balance →",
        "    (0 : Int) ≤ v_amount →",
        "    v_amount < (1000 : Int) →",
        "    ((decide ((f_take v_balance v_amount).left ≥ (0 : Int))) = true)",
      ].join("\n"),
    );
  });

  test("iff on booleans; SameValue on integers and booleans, refused on records", () => {
    const b = prop("b");
    const d = prop("d");
    const e = prop("e");
    if (!b || !d || !e) throw new Error("fixtures");
    expect(statement(b, module)).toContain(
      "(((f_take v_balance v_amount).ok = true) ↔ ((decide (v_amount ≤ v_balance)) = true))",
    );
    // SameValue on two objects is reference identity in JavaScript, which Lean's = is not; on numbers it
    // tells -0 from 0, which Int does not. On booleans it is plain equality.
    expect(() => statement(d, module)).toThrow("compares records");
    expect(() => statement(e, module)).toThrow("different types");
    const g = prop("g");
    const h = prop("h");
    if (!g || !h) throw new Error("fixtures");
    expect(() => statement(g, module)).toThrow("tells -0 from 0");
    const i = prop("i");
    if (!i) throw new Error("fixtures");
    expect(() => statement(i, module)).toThrow("over bigint");
    expect(statement(h, module)).toContain(
      "((f_take v_balance (1 : Int)).ok = (decide ((1 : Int) ≤ v_balance)))",
    );
  });

  test("a binder over number and a non-boolean atom are outside the engine", () => {
    const c = prop("c");
    const f = prop("f");
    if (!c || !f) throw new Error("fixtures");
    expect(() => statement(c, module)).toThrow("over number");
    expect(() => statement(f, module)).toThrow("is not boolean");
  });
});

describe("emitModule", () => {
  test("structures, definitions with let and conditionals, one theorem per statable property, lines mapped", () => {
    const emitted = emitModule(
      module,
      fn.ensures.map((property) => ({ function: fn.name, property })),
      ["example : f_take 5 3 = ({ ok := true, left := 2 } : R_Decision) := by decide"],
    );
    expect(emitted.source).toContain(
      "structure R_Decision where\n  ok : Bool\n  left : Int\n  deriving Repr, DecidableEq",
    );
    expect(emitted.source).toContain(
      "def f_take (v_balance : Int) (v_amount : Int) : R_Decision :=\n  (let v_fits := (decide (v_amount ≤ v_balance)); (if v_fits = true then ({ ok := true, left := (v_balance - v_amount) } : R_Decision) else ({ ok := false, left := v_balance } : R_Decision)))",
    );
    expect(emitted.theorems.map((t) => t.property)).toEqual(["a", "b", "h"]);
    expect(emitted.skipped.map((s) => s.property)).toEqual(["c", "d", "e", "f", "g", "i"]);
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
    const src =
      "/**\n * @ensures{a-b} forall (x: int) { f(x) === x }\n * @ensures{a_b} forall (x: int) { f(x) === x }\n */\nexport function f(x: number): number { return x; }";
    const m = readSubset(src);
    const fn = extractSpecs(src).functions[0] as FunctionSpec;
    const emitted = emitModule(
      m,
      fn.ensures.map((property) => ({ function: "f", property })),
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
