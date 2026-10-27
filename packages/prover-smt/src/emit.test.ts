import { readSpecs, readSubset } from "@eutaxy/prover/reader";
import type { Property } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import {
  decode,
  equal,
  numberTerm,
  parseSExprs,
  prelude,
  propertyScript,
  readAnswer,
  stringTerm,
  symbol,
  value,
} from "./emit.ts";

const source = `
export interface Decision { readonly ok: boolean; readonly left: number }
export function take(balance: number, amount: number): Decision {
  const fits = amount <= balance;
  return fits ? { left: balance - amount, ok: true } : { ok: false, left: balance };
}
export function tag(n: number, s: string): string { return s + "!"; }
export function one(): number { return 1; }
`;
const specSource = `
import { forall } from "eutaxy/spec";
import { one, tag, take } from "./domain.ts";
export const a = forall(take, {
  when: (balance, amount) => Number.isInteger(amount) && 0 <= balance,
  ensures: (balance, amount) => take(balance, amount).left >= 0 || amount > balance,
});
export const b = forall(tag, { ensures: (n, s) => tag(n, s) !== "" && n === n });
export const c = forall(take, { ensures: (balance) => take(balance, 1) === take(balance, 1) });
export const d = forall(one, { ensures: () => one() === 1 });
`;
const module = readSubset(source);
const specs = readSpecs({ module: source, spec: specSource, moduleSpecifiers: ["./domain.ts"] });
const prop = (name: string): Property => {
  const p = specs.functions.flatMap((f) => f.properties).find((x) => x.name === name);
  if (!p) throw new Error(`no property ${name}`);
  return p;
};

describe("terms", () => {
  test("doubles round-trip through their bits; the special values have their own spelling", () => {
    expect(numberTerm(1)).toBe(
      "(fp #b0 #b01111111111 #b0000000000000000000000000000000000000000000000000000)",
    );
    expect(numberTerm(-0)).toBe("(_ -zero 11 53)");
    expect(numberTerm(0)).toBe("(_ +zero 11 53)");
    expect(numberTerm(Number.NaN)).toBe("(_ NaN 11 53)");
    expect(numberTerm(Number.NEGATIVE_INFINITY)).toBe("(_ -oo 11 53)");
    for (const n of [0.1, -2.5, 1e300, 5e-324, 2 ** 53 + 2])
      expect(decode(parseSExprs(numberTerm(n))[0] as never, { kind: "int" }, module)).toBe(n);
  });

  test("strings are sequences of UTF-16 code units, so a surrogate pair is two units", () => {
    expect(stringTerm("")).toBe("(as seq.empty (Seq (_ BitVec 16)))");
    expect(stringTerm("a")).toBe("(seq.unit #x0061)");
    expect(stringTerm("a😀")).toBe(
      "(seq.++ (seq.unit #x0061) (seq.unit #xd83d) (seq.unit #xde00))",
    );
    expect(decode(parseSExprs(stringTerm("a😀"))[0] as never, { kind: "string" }, module)).toBe(
      "a😀",
    );
  });

  test("symbols: simple when they can be, quoted otherwise", () => {
    expect(symbol("f_decide")).toBe("f_decide");
    expect(symbol("v_λ")).toBe("|v_λ|");
    expect(symbol("a|b")).toBe("|a_b|");
  });
});

describe("prelude and property scripts", () => {
  test("datatypes with prefixed selectors, functions as define-fun with record fields in declaration order", () => {
    const pre = prelude(module);
    expect(pre).toContain(
      "(declare-datatype R_Decision ((mk_Decision (fld.Decision.ok Bool) (fld.Decision.left (_ FloatingPoint 11 53)))))",
    );
    expect(pre).toContain(
      "(define-fun f_take ((v_balance (_ FloatingPoint 11 53)) (v_amount (_ FloatingPoint 11 53))) R_Decision\n  (let ((v_fits (fp.leq v_amount v_balance))) (ite v_fits (mk_Decision true (fp.sub RNE v_balance v_amount)) (mk_Decision false v_balance))))",
    );
    expect(pre).toContain(
      "(define-fun f_tag ((v_n (_ FloatingPoint 11 53)) (v_s (Seq (_ BitVec 16)))) (Seq (_ BitVec 16))\n  (seq.++ v_s (seq.unit #x0021)))",
    );
    expect(pre).toContain("(define-fun f_one () (_ FloatingPoint 11 53)\n  (fp #b0 #b01111111111");
  });

  test("a property: binders as constants, the precondition asserted, the claim negated, Number.isInteger as the finite round trip", () => {
    const { script, binders } = propertyScript(prop("a"), module);
    expect(binders.map((b) => b.symbol)).toEqual(["v_balance", "v_amount"]);
    expect(script).toContain("(declare-const v_balance (_ FloatingPoint 11 53))");
    expect(script).toContain(
      "(assert (and (and (not (fp.isNaN v_amount)) (not (fp.isInfinite v_amount)) (fp.eq v_amount (fp.roundToIntegral RTZ v_amount))) (fp.leq (_ +zero 11 53) v_balance)))",
    );
    expect(script).toContain(
      "(assert (not (or (fp.geq (fld.Decision.left (f_take v_balance v_amount)) (_ +zero 11 53)) (fp.gt v_amount v_balance))))",
    );
    expect(script).toContain("(check-sat)\n(get-value (v_balance v_amount))");
  });

  test("=== on numbers is fp.eq, on strings =; a zero-parameter function is a bare symbol", () => {
    expect(propertyScript(prop("b"), module).script).toContain(
      "(assert (not (and (not (= (f_tag v_n v_s) (as seq.empty (Seq (_ BitVec 16))))) (fp.eq v_n v_n))))",
    );
    const d = propertyScript(prop("d"), module);
    expect(d.binders).toEqual([]);
    expect(d.script).toContain("(assert (not (fp.eq f_one (fp #b0 #b01111111111");
    expect(d.script).not.toContain("get-value");
  });

  test("=== on records is outside the engine", () => {
    expect(() => propertyScript(prop("c"), module)).toThrow("compares references");
  });

  test("values and equality for translation checks", () => {
    expect(value({ ok: true, left: 2 }, { kind: "record", name: "Decision" }, module)).toBe(
      "(mk_Decision true (fp #b0 #b10000000000 #b0000000000000000000000000000000000000000000000000000))",
    );
    expect(equal("a", "b", { kind: "record", name: "Decision" }, module)).toBe(
      "(and (= (fld.Decision.ok a) (fld.Decision.ok b)) (fp.eq (fld.Decision.left a) (fld.Decision.left b)))",
    );
  });
});

describe("reading Z3", () => {
  test("answers: the result, the values by symbol, the reason when unknown", () => {
    const sat = readAnswer(
      'sat\n((v_x (fp #b1 #b00000000001 #x0000000000000)) (v_s (seq.++ (seq.unit #x0061) (seq.unit #x0021))) (v_r (mk_R true (_ NaN 11 53))))\n(error "line 9: no reason")\n',
    );
    expect(sat.result).toBe("sat");
    expect(decode(sat.values.get("v_x") as never, { kind: "int" }, module)).toBe(
      -2.2250738585072014e-308,
    );
    expect(decode(sat.values.get("v_s") as never, { kind: "string" }, module)).toBe("a!");
    const unsat = readAnswer(
      'unsat\n(error "line 9 column 45: model is not available")\n(:reason-unknown "")\n',
    );
    expect(unsat.result).toBe("unsat");
    const unknown = readAnswer(
      'unknown\n(error "model is not available")\n(:reason-unknown "max. resource limit exceeded")\n',
    );
    expect(unknown).toMatchObject({ result: "unknown", reason: "max. resource limit exceeded" });
    const broken = readAnswer('(error "line 3 column 10: unknown sort")\n');
    expect(broken.result).toBe("error");
    expect(broken.reason).toContain("unknown sort");
  });

  test("records decode field by field; a value of another shape is unreadable, never guessed", () => {
    const r = parseSExprs("(mk_Decision false (_ -zero 11 53))")[0] as never;
    expect(decode(r, { kind: "record", name: "Decision" }, module)).toEqual({
      ok: false,
      left: -0,
    });
    expect(() => decode("7" as never, { kind: "int" }, module)).toThrow("not a double");
    expect(() =>
      decode(parseSExprs("(mk_Other 1)")[0] as never, { kind: "record", name: "Decision" }, module),
    ).toThrow("not a Decision");
  });
});

describe("review findings", () => {
  test("a literal binder constrains the solver to its values, so a widened sort never yields an input outside the type", () => {
    const src = 'export function pick(s: "a" | "b"): "a" | "b" { return s; }';
    const sp = readSpecs({
      module: src,
      spec: 'import { forall } from "eutaxy/spec";\nimport { pick } from "./m.ts";\nexport const p = forall(pick, { ensures: (s) => pick(s) === "a" || pick(s) === "b" });',
      moduleSpecifiers: ["./m.ts"],
    });
    const m = readSubset(src);
    const [p] = sp.functions.flatMap((f) => f.properties);
    if (!p) throw new Error("fixture");
    expect(propertyScript(p, m).script).toContain(
      "(assert (or (= v_s (seq.unit #x0061)) (= v_s (seq.unit #x0062))))",
    );
  });

  test("a record without fields is a nullary constructor everywhere", () => {
    const src =
      "export interface Empty {}\nexport function same(e: Empty): Empty { return e; }\nexport function fresh(): Empty { return {}; }";
    const m = readSubset(src);
    const pre = prelude(m);
    expect(pre).toContain("(declare-datatype R_Empty ((mk_Empty)))");
    expect(pre).toContain("(define-fun f_fresh () R_Empty\n  mk_Empty)");
    expect(value({}, { kind: "record", name: "Empty" }, m)).toBe("mk_Empty");
    expect(equal("a", "b", { kind: "record", name: "Empty" }, m)).toBe("true");
    expect(decode("mk_Empty", { kind: "record", name: "Empty" }, m)).toEqual({});
  });

  test("selectors of records whose names share a prefix never coincide", () => {
    const src =
      "export interface A_B { readonly c: number }\nexport interface A { readonly B_c: number }\nexport function f(x: A_B, y: A): number { return x.c + y.B_c; }";
    const pre = prelude(readSubset(src));
    expect(pre).toContain("(fld.A_B.c (_ FloatingPoint 11 53))");
    expect(pre).toContain("(fld.A.B_c (_ FloatingPoint 11 53))");
  });

  test("an error Z3 printed before a verdict line is kept, so the verdict is not trusted", () => {
    const tainted = readAnswer(
      '(error "line 4 column 10: unknown constant v_z")\nsat\n((v_x (_ NaN 11 53)))\n',
    );
    expect(tainted.result).toBe("sat");
    expect(tainted.errors).toEqual(['(error "line 4 column 10: unknown constant v_z")']);
    expect(
      readAnswer('unsat\n(error "line 9 column 45: model is not available")\n').errors,
    ).toEqual([]);
  });
});
