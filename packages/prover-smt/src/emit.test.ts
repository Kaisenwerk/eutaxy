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
const specs = readSpecs({ module: source, spec: specSource, modulePath: "/virtual/domain.ts" });
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
    expect(symbol("a|b")).toBe("a%7cb");
  });
});

describe("prelude and property scripts", () => {
  test("datatypes with prefixed selectors, functions as define-fun with record fields in declaration order", () => {
    const pre = prelude(module);
    expect(pre).toContain(
      "(declare-datatypes ((R_Decision 0) (Opt.F64 0) (Opt.Bool 0) (Opt.Str 0) (Opt.R_Decision 0)) (((mk_Decision (fld.Decision.ok Bool) (fld.Decision.left (_ FloatingPoint 11 53))))",
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
      modulePath: "/virtual/m.ts",
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
    expect(pre).toContain(
      "(declare-datatypes ((R_Empty 0) (Opt.F64 0) (Opt.Bool 0) (Opt.Str 0) (Opt.R_Empty 0)) (((mk_Empty))",
    );
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

describe("nullable types and tagged unions", () => {
  const src = `
export interface Challenge { readonly attempts: number; readonly locked: boolean }
export type Refused = { readonly type: "invalid_code" } | { readonly type: "code_locked" };
export type Outcome = { readonly ok: true; readonly value: Challenge } | { readonly ok: false; readonly error: Refused };
export function admit(c: Challenge | null, matches: boolean): Outcome {
  if (c === null) return { ok: false, error: { type: "invalid_code" } };
  if (c.locked) return { ok: false, error: { type: "code_locked" } };
  if (!matches) return { ok: false, error: { type: "invalid_code" } };
  return { ok: true, value: c };
}
export function decideAccess(status: "invited" | "active" | "disabled" | null): "send_code" | "waitlist" {
  if (status === "invited" || status === "active") return "send_code";
  return "waitlist";
}
`;
  const m = readSubset(src);
  const pre = prelude(m);

  test("one datatypes block: records, unions with a constructor per member holding its record, options over the sorts used", () => {
    expect(pre).toContain(
      "(declare-datatypes ((R_Challenge 0) (R_Refused.invalid_code 0) (R_Refused.code_locked 0) (R_Outcome.true 0) (R_Outcome.false 0) (R_Refused 0) (R_Outcome 0) (Opt.F64 0)",
    );
    expect(pre).toContain(
      "((mk_Refused.invalid_code (fld.Refused.invalid_code.type (Seq (_ BitVec 16)))))",
    );
    expect(pre).toContain(
      "((mk_Outcome.true (fld.Outcome.true.ok Bool) (fld.Outcome.true.value R_Challenge)))",
    );
    expect(pre).toContain(
      "((in.Outcome.Outcome.true (out.Outcome.Outcome.true R_Outcome.true)) (in.Outcome.Outcome.false (out.Outcome.Outcome.false R_Outcome.false)))",
    );
    expect(pre).toContain("((none.R_Challenge) (some.R_Challenge (val.R_Challenge R_Challenge)))");
    expect(pre).toContain("(define-fun f_admit ((v_c Opt.R_Challenge) (v_matches Bool)) R_Outcome");
  });

  test("a null check is a tester; a narrowed name is bound to its value in the branch it guards", () => {
    // A member literal where its union is expected is wrapped in the union's constructor for it.
    expect(pre).toContain(
      "(ite (is-none.R_Challenge v_c) (in.Outcome.Outcome.false (mk_Outcome.false false (in.Refused.Refused.invalid_code (mk_Refused.invalid_code (seq.++",
    );
    expect(pre).toContain("(let ((v_c (val.R_Challenge v_c))) (ite (fld.Challenge.locked v_c)");
  });

  test("a nullable string against a literal: some and equal", () => {
    expect(pre).toContain("(and (is-some.Str v_status) (= (val.Str v_status) (seq.++");
  });

  test("binders: a nullable record, a nullable union of literals constrained to them, a union of records matched to its declaration", () => {
    const sp = readSpecs({
      module: src,
      spec: `import { forall } from "eutaxy/spec";
import { admit, decideAccess } from "./m.ts";
export const admits = forall(admit, { when: (c) => c !== null && !c.locked, ensures: (c, m) => admit(c, m).ok === m });
export const sendCode = forall(decideAccess, { ensures: (s) => decideAccess(s) === "send_code" || s === null || s === "disabled" });`,
      modulePath: "/virtual/m.ts",
    });
    expect(sp.errors).toEqual([]);
    const [admits, sendCode] = sp.functions.flatMap((f) => f.properties);
    if (!admits || !sendCode) throw new Error("fixtures");
    const a = propertyScript(admits, m);
    expect(a.script).toContain("(declare-const v_c Opt.R_Challenge)");
    expect(a.script).toContain(
      "(assert (and (not (is-none.R_Challenge v_c)) (let ((v_c (val.R_Challenge v_c))) (not (fld.Challenge.locked v_c)))))",
    );
    // The tag read on the union, from whichever member the value holds.
    expect(a.script).toContain(
      "(ite (is-in.Outcome.Outcome.true (f_admit v_c v_m)) (fld.Outcome.true.ok (out.Outcome.Outcome.true (f_admit v_c v_m))) (fld.Outcome.false.ok (out.Outcome.Outcome.false (f_admit v_c v_m))))",
    );
    const s = propertyScript(sendCode, m);
    expect(s.script).toContain(
      "(assert (or (is-none.Str v_s) (and (is-some.Str v_s) (or (= (val.Str v_s)",
    );
  });

  test("values and models of the new types", () => {
    const c = { attempts: 1, locked: false };
    expect(value(null, { kind: "nullable", inner: { kind: "record", name: "Challenge" } }, m)).toBe(
      "none.R_Challenge",
    );
    expect(
      value(c, { kind: "nullable", inner: { kind: "record", name: "Challenge" } }, m),
    ).toContain("(some.R_Challenge (mk_Challenge");
    expect(value({ ok: true, value: c }, { kind: "union", name: "Outcome" }, m)).toContain(
      "(in.Outcome.Outcome.true (mk_Outcome.true true (mk_Challenge",
    );
    expect(
      decode(
        "none.R_Challenge",
        { kind: "nullable", inner: { kind: "record", name: "Challenge" } },
        m,
      ),
    ).toBeNull();
    const some = parseSExprs("(some.R_Challenge (mk_Challenge (_ NaN 11 53) true))")[0] as never;
    expect(
      decode(some, { kind: "nullable", inner: { kind: "record", name: "Challenge" } }, m),
    ).toEqual({ attempts: Number.NaN, locked: true });
    const o = parseSExprs(
      "(in.Outcome.Outcome.false (mk_Outcome.false false (in.Refused.Refused.code_locked (mk_Refused.code_locked (seq.unit #x0061)))))",
    )[0] as never;
    expect(decode(o, { kind: "union", name: "Outcome" }, m)).toEqual({
      ok: false,
      error: { type: "a" },
    });
    expect(equal("a", "b", { kind: "nullable", inner: { kind: "int" } }, m)).toBe(
      "(ite (and (is-some.F64 a) (is-some.F64 b)) (fp.eq (val.F64 a) (val.F64 b)) (and (is-none.F64 a) (is-none.F64 b)))",
    );
  });
});

describe("nullable types and tagged unions, after review", () => {
  const src = `
export interface Challenge { readonly attempts: number; readonly locked: boolean }
export interface A { readonly t: "a"; readonly n: number }
export interface B { readonly t: "b"; readonly n: number }
export type U = A | B;
export function maybe(x: number, c: Challenge): Challenge | null { return x > 0 ? c : c; }
export function local(c: Challenge, x: number): number {
  const d = x > 0 ? c : null;
  return d === null ? 0 : d.attempts;
}
export function annotated(): number | null {
  const x: number | null = null;
  return x;
}
export function pick(b: boolean): number | null { return b ? 1 : 2; }
export function onlyA(a: A): number { return a.n; }
export function tagOf(u: U): string { return u.t; }
`;
  const m = readSubset(src);
  const pre = prelude(m);

  test("a conditional, a let or a null where a nullable is expected is wrapped once", () => {
    expect(pre).toContain(
      "(define-fun f_maybe ((v_x (_ FloatingPoint 11 53)) (v_c R_Challenge)) Opt.R_Challenge\n  (ite (fp.gt v_x (_ +zero 11 53)) (some.R_Challenge v_c) (some.R_Challenge v_c)))",
    );
    expect(pre).not.toContain("(some.R_Challenge (ite");
    expect(pre).toContain("(define-fun f_pick ((v_b Bool)) Opt.F64\n  (ite v_b (some.F64");
    expect(pre).toContain("(define-fun f_annotated () Opt.F64\n  (let ((v_x none.F64)) v_x))");
  });

  test("option sorts exist for every sort, so a local join with null declares nothing new", () => {
    expect(pre).toContain(
      "(Opt.F64 0) (Opt.Bool 0) (Opt.Str 0) (Opt.R_Challenge 0) (Opt.R_A 0) (Opt.R_B 0) (Opt.R_U 0)",
    );
    expect(pre).toContain(
      "(let ((v_d (ite (fp.gt v_x (_ +zero 11 53)) (some.R_Challenge v_c) none.R_Challenge)))",
    );
  });

  test("a binder over a member record is that record; a union binder's members carry their tags", () => {
    const sp = readSpecs({
      module: src,
      spec: `import { forall } from "eutaxy/spec";
import { onlyA, tagOf } from "./m.ts";
export const a = forall(onlyA, { ensures: (x) => onlyA(x) === x.n });
export const tags = forall(tagOf, { ensures: (u) => tagOf(u) === "a" || tagOf(u) === "b" });`,
      modulePath: "/virtual/m.ts",
    });
    expect(sp.errors).toEqual([]);
    const [a, tags] = sp.functions.flatMap((f) => f.properties);
    if (!a || !tags) throw new Error("fixtures");
    expect(propertyScript(a, m).script).toContain("(assert (= (fld.A.t v_x) (seq.unit #x0061)))");
    expect(propertyScript(tags, m).script).toContain(
      "(assert (or (and (is-in.U.A v_u) (= (fld.A.t (out.U.A v_u)) (seq.unit #x0061))) (and (is-in.U.B v_u) (= (fld.B.t (out.U.B v_u)) (seq.unit #x0062)))))",
    );
  });
});

describe("records in several unions, after review", () => {
  const src = `
export interface A { readonly tag: "ok"; readonly data: "a" }
export interface B { readonly tag: "ok"; readonly data: "a" | "b" }
export interface E { readonly tag: "err" }
export type U1 = A | E;
export type U2 = B | E;
export function id(x: U2): U2 { return x; }
export function first(x: U1): U1 { return x; }
`;
  const m = readSubset(src);

  test("a union binder is the one union whose members' fields match type for type", () => {
    const sp = readSpecs({
      module: src,
      spec: `import { forall } from "eutaxy/spec";
import { first, id } from "./m.ts";
export const wide = forall(id, { ensures: (x) => x.tag !== "ok" || x.data === "a" });
export const narrow = forall(first, { ensures: (x) => x.tag !== "ok" || x.data === "a" });`,
      modulePath: "/virtual/m.ts",
    });
    expect(sp.errors).toEqual([]);
    const [wide, narrow] = sp.functions.flatMap((f) => f.properties);
    if (!wide || !narrow) throw new Error("fixtures");
    // B's data is a union of literals, any string to the sort: x is a U2, so "b" stays possible.
    expect(propertyScript(wide, m).script).toContain("(declare-const v_x R_U2)");
    expect(propertyScript(narrow, m).script).toContain("(declare-const v_x R_U1)");
  });

  test("a member's field typed as another union's inline member is matched by its fields", () => {
    const nested = `
export type U = { readonly tag: "a"; readonly n: number } | { readonly tag: "b" };
export type A = Extract<U, { tag: "a" }>;
export type W = { readonly kind: "x"; readonly inner: A } | { readonly kind: "y" };
export function f(w: W): W { return w; }
`;
    const mn = readSubset(nested);
    expect(mn.outside).toEqual([]);
    const sp = readSpecs({
      module: nested,
      spec: `import { forall } from "eutaxy/spec";
import { f } from "./m.ts";
export const p = forall(f, { ensures: (w) => w.kind === "x" || w.kind === "y" });`,
      modulePath: "/virtual/m.ts",
    });
    const [p] = sp.functions.flatMap((fn) => fn.properties);
    if (!p) throw new Error("fixtures");
    expect(propertyScript(p, mn).script).toContain("(declare-const v_w R_W)");
  });

  test("members no one declared union matches exactly leave the binder outside", () => {
    const twin = `
export interface A { readonly tag: "ok"; readonly n: number }
export interface E { readonly tag: "err" }
export type V1 = A | E;
export type V2 = A | E;
export function f(x: V1): V1 { return x; }
`;
    const mt = readSubset(twin);
    const sp = readSpecs({
      module: twin,
      spec: `import { forall } from "eutaxy/spec";
import { f } from "./m.ts";
export const p = forall(f, { ensures: (x) => x.tag === "ok" || x.tag === "err" });`,
      modulePath: "/virtual/m.ts",
    });
    const [p] = sp.functions.flatMap((fn) => fn.properties);
    if (!p) throw new Error("fixtures");
    expect(() => propertyScript(p, mt)).toThrow(/no one union/);
  });
});

describe("symbol", () => {
  test("quotes what SMT-LIB cannot spell, injectively: names differing by | or \\ stay apart", () => {
    expect(symbol("plain_name")).toBe("plain_name");
    expect(symbol('Box<"a|b">')).not.toBe(symbol('Box<"a_b">'));
    expect(symbol('Box<"a\\b">')).not.toBe(symbol('Box<"a_b">'));
    expect(symbol('Box<"a|b">').slice(1, -1)).not.toContain("|");
    // A quoted symbol and a simple one spelled alike are one symbol to SMT-LIB: % is escaped always.
    expect(symbol("a%7cb")).not.toBe(symbol("a|b").slice(1, -1));
    expect(symbol("a%7cb")).not.toBe(symbol("a|b"));
  });
});

describe("narrowed branches where a nullable is expected", () => {
  test("a value returned under a tag test or a null check is wrapped in the option's constructor", () => {
    const module = readSubset(`
export type U = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly value: number };
export function f(u: U): number | null { return u.ok ? u.value : null; }
export function g(x: number | null): number | null { if (x !== null) return x; return null; }
`);
    expect(module.outside).toEqual([]);
    const text = prelude(module);
    const f = text.slice(text.indexOf("f_f"));
    expect(f.slice(0, f.indexOf("f_g"))).toContain("(some.F64 ");
    expect(f.slice(f.indexOf("f_g"))).toContain("(some.F64 ");
  });
});
