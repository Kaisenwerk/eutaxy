/**
 * Lean 4 for a module in the subset and the Lemma properties on it. The
 * module's record types become structures, its functions definitions over
 * `Int` and `Bool`, each property a theorem whose statement is the
 * property's formula over its binders, with the binders' domains, guards
 * and preconditions as hypotheses. Booleans stay `Bool` in terms, as in
 * TypeScript, and become propositions with `= true` where a formula needs
 * one; comparisons are `decide`d. Every theorem is closed by one tactic
 * script, so what Lean checks is the statement, not a hand proof.
 */

import type { Binder, Formula, NamedProperty, Property } from "@eutaxy/spec";
import {
  type Expr,
  OutsideSubset,
  type RecordType,
  readExpression,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
} from "./subset.ts";

/**
 * TypeScript names as Lean identifiers that can clash with nothing Lean
 * defines and not with each other: functions get `f_`, record types `R_`,
 * variables `v_`, theorems `t_`. The schemes differ in their first letter,
 * so no two names from different kinds coincide whatever the author
 * wrote (`ts_f` and `f_` would, under suffixing), and Lean's prelude has
 * no names of these shapes, so a function called `decide` or a parameter
 * called `max` stays what the author meant.
 */
export const ident = {
  fn: (name: string) => quote(`f_${name}`),
  record: (name: string) => quote(`R_${name}`),
  variable: (name: string) => quote(`v_${name}`),
  // Fields keep their names, which may be Lean keywords: those are quoted.
  field: (name: string) => (leanKeywords.has(name) ? `«${name}»` : quote(name)),
};

/** Lean's keywords, which a field name may coincide with. */
const leanKeywords = new Set(
  "at by calc def deriving do else end example export extends from fun have if import in inductive instance lemma let macro match mutual namespace open private protected return section set_option show structure syntax termination_by then theorem universe variable where with abbrev axiom class opaque partial noncomputable unsafe nomatch nofun omit include local scoped attribute initialize builtin_initialize elab notation infix infixl infixr prefix postfix declare_syntax_cat macro_rules elab_rules syntax_rules suffices obtain exists forall Type Prop Sort true false fun".split(
    " ",
  ),
);

function quote(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `«${name}»`;
}

function leanType(t: SubsetType): string {
  switch (t.kind) {
    case "int":
      return "Int";
    case "bool":
      return "Bool";
    case "record":
      return ident.record(t.name);
  }
}

export function emitRecord(r: RecordType): string {
  return [
    `structure ${ident.record(r.name)} where`,
    ...r.fields.map((f) => `  ${ident.field(f.name)} : ${leanType(f.type)}`),
    "  deriving Repr, DecidableEq",
  ].join("\n");
}

interface Env {
  readonly module: SubsetModule;
  readonly ctx: TypeContext;
}

function env(module: SubsetModule): Env {
  return {
    module,
    ctx: {
      records: new Map(module.records.map((r) => [r.name, r])),
      signatures: new Map(
        module.functions.map((f) => [f.name, { params: f.params, returns: f.returns }]),
      ),
    },
  };
}

const fail: (message: string) => never = (message) => {
  throw new OutsideSubset(message, 0);
};

/** A term of the expression's TypeScript type: `Int`, `Bool` or a structure. */
export function term(e: Expr, scope: ReadonlyMap<string, SubsetType>, env: Env): string {
  const t = (x: Expr) => term(x, scope, env);
  switch (e.kind) {
    case "int":
      return `(${e.value} : Int)`;
    case "bool":
      return e.value ? "true" : "false";
    case "var":
      return ident.variable(e.name);
    case "neg":
      return `(-${t(e.operand)})`;
    case "not":
      return `(!${t(e.operand)})`;
    case "binary":
      switch (e.op) {
        case "+":
        case "-":
        case "*":
          return `(${t(e.left)} ${e.op} ${t(e.right)})`;
        case "<":
        case ">":
          return `(decide (${t(e.left)} ${e.op} ${t(e.right)}))`;
        case "<=":
          return `(decide (${t(e.left)} ≤ ${t(e.right)}))`;
        case ">=":
          return `(decide (${t(e.left)} ≥ ${t(e.right)}))`;
        case "===":
        case "!==": {
          // === on objects compares references in JavaScript; Lean's = would compare the fields.
          const lt = typeOf(e.left, scope, env.ctx, fail);
          if (lt.kind === "record")
            fail(
              `${e.op} on records compares references in JavaScript; compare their fields instead`,
            );
          return `(decide (${t(e.left)} ${e.op === "===" ? "=" : "≠"} ${t(e.right)}))`;
        }
        case "&&":
          return `(${t(e.left)} && ${t(e.right)})`;
        case "||":
          return `(${t(e.left)} || ${t(e.right)})`;
      }
      break;
    case "cond":
      return `(if ${t(e.test)} = true then ${t(e.ifTrue)} else ${t(e.ifFalse)})`;
    case "call":
      return `(${ident.fn(e.callee)}${e.args.map((a) => ` ${t(a)}`).join("")})`;
    case "field":
      return `${t(e.object)}.${ident.field(e.field)}`;
    case "record": {
      const type = typeOf(e, scope, env.ctx, fail);
      const name =
        type.kind === "record"
          ? ident.record(type.name)
          : fail("a record literal of no record type");
      return `({ ${e.fields.map((f) => `${ident.field(f.name)} := ${t(f.value)}`).join(", ")} } : ${name})`;
    }
    case "let": {
      const inner = new Map(scope);
      inner.set(e.name, typeOf(e.value, scope, env.ctx, fail));
      return `(let ${ident.variable(e.name)} := ${t(e.value)}; ${term(e.body, inner, env)})`;
    }
  }
}

export function emitFunction(f: SubsetFunction, module: SubsetModule): string {
  const e = env(module);
  const scope = new Map(f.params.map((p) => [p.name, p.type]));
  const params = f.params.map((p) => `(${ident.variable(p.name)} : ${leanType(p.type)})`).join(" ");
  return `def ${ident.fn(f.name)} ${params} : ${leanType(f.returns)} :=\n  ${term(f.body, scope, e)}`;
}

/** The Lean type a binder ranges over, or `OutsideSubset`. */
function binderType(b: Binder): SubsetType {
  switch (b.domain) {
    case "int":
    case "nat":
      return { kind: "int" };
    case "boolean":
      return { kind: "bool" };
    case "bigint":
      // A BigInt passed to a function over number throws on the first mixed operation in JavaScript.
      fail(
        `binder ${b.name} over bigint: the subset has no bigint, and a bigint argument to a number function throws`,
      );
      break;
    case "number":
      fail(`binder ${b.name} over number: the engine models integers, not doubles`);
      break;
    case "string":
      fail(`binder ${b.name} over string: the subset has no strings yet`);
  }
}

/** The hypotheses a binder's domain and guard add. */
function binderHypotheses(b: Binder): string[] {
  const out: string[] = [];
  const x = ident.variable(b.name);
  if (b.domain === "nat") out.push(`0 ≤ ${x}`);
  const g = b.guard;
  if (!g) return out;
  if (g.kind === "regex") fail(`a regex guard on ${b.name}`);
  const literal = (v: string) => v.replace(/_/g, "").replace(/n$/, "");
  if (!g.lower.value.endsWith("∞"))
    out.push(`(${literal(g.lower.value)} : Int) ${g.lower.inclusive ? "≤" : "<"} ${x}`);
  if (!g.upper.value.endsWith("∞"))
    out.push(`${x} ${g.upper.inclusive ? "≤" : "<"} (${literal(g.upper.value)} : Int)`);
  return out;
}

/** A formula as a proposition. */
function prop(f: Formula, scope: ReadonlyMap<string, SubsetType>, e: Env): string {
  const p = (x: Formula) => prop(x, scope, e);
  const expr = (text: string) => readExpression(text, scope, e.module);
  switch (f.kind) {
    case "atom": {
      const x = expr(f.text);
      const t = typeOf(x, scope, e.ctx, fail);
      if (t.kind !== "bool") fail(`atom ${f.text.trim()} is not boolean`);
      return `(${term(x, scope, e)} = true)`;
    }
    case "equation": {
      const l = expr(f.left);
      const r = expr(f.right);
      const lt = typeOf(l, scope, e.ctx, fail);
      const rt = typeOf(r, scope, e.ctx, fail);
      if (leanType(lt) !== leanType(rt))
        fail(`${f.left.trim()} and ${f.right.trim()} have different types`);
      if (lt.kind === "record")
        fail(
          `${f.left.trim()} ≡ ${f.right.trim()} compares records: SameValue on objects is reference identity in JavaScript; compare their fields instead`,
        );
      if (lt.kind === "int")
        fail(
          `${f.left.trim()} ≡ ${f.right.trim()} compares numbers by SameValue, which tells -0 from 0; the integer model does not, so use === for numeric equality`,
        );
      return `(${term(l, scope, e)} ${f.negated ? "≠" : "="} ${term(r, scope, e)})`;
    }
    case "not":
      return `(¬ ${p(f.operand)})`;
    case "and":
      return `(${f.operands.map(p).join(" ∧ ")})`;
    case "or":
      return `(${f.operands.map(p).join(" ∨ ")})`;
    case "implies":
      return `(${[...f.antecedents, f.consequent].map(p).join(" → ")})`;
    case "iff":
      return `(${p(f.left)} ↔ ${p(f.right)})`;
  }
}

/** The proposition a property claims: binders universally quantified, hypotheses in front. */
export function statement(property: Property, module: SubsetModule): string {
  return stated(property, module).text;
}

/** The statement and how many hypotheses stand before the claim (the tactic script introduces them by name). */
export function stated(
  property: Property,
  module: SubsetModule,
): { readonly text: string; readonly hypotheses: number } {
  const e = env(module);
  const scope = new Map(property.binders.map((b) => [b.name, binderType(b)]));
  const binders = property.binders
    .map((b) => `(${ident.variable(b.name)} : ${leanType(binderType(b))})`)
    .join(" ");
  const hyps = [
    ...property.binders.flatMap(binderHypotheses),
    ...property.requires.map((r) => prop(r, scope, e)),
  ];
  const claim = prop(property.claim, scope, e);
  return {
    text: `∀ ${binders},\n    ${[...hyps, claim].join(" →\n    ")}`,
    hypotheses: hyps.length,
  };
}

/**
 * The tactic script every theorem is closed by. Booleans become
 * propositions first, while the `Decidable` instances in the statement
 * still match their propositions (unfolding under `decide` first leaves
 * them stale and stops `simp`); Bool binders are cased, so boolean claims
 * are decided by enumeration; then the module's definitions unfold, each
 * conditional splits, and linear integer arithmetic (`omega`) closes what
 * remains. Nothing here is specific to a property; what Lean checks is
 * the statement.
 */
export function tactics(module: SubsetModule, property: Property, hypotheses: number): string {
  const defs = module.functions.map((f) => ident.fn(f.name)).join(", ");
  const names = property.binders.map((b) => ident.variable(b.name));
  const hyps = Array.from({ length: hypotheses }, (_, i) => `h${i}_`);
  const bools = property.binders
    .filter((b) => b.domain === "boolean")
    .map((b) => ident.variable(b.name));
  return [
    `  intro ${[...names, ...hyps].join(" ")}`,
    ...(bools.length > 0 ? [`  ${bools.map((b) => `cases ${b}`).join(" <;> ")}`] : []),
    "  all_goals (try simp_all)",
    `  all_goals (try simp only [${defs}] at *)`,
    "  all_goals (repeat' (split <;> simp_all))",
    "  all_goals (try simp_all)",
    "  all_goals (first | decide | trivial | omega)",
  ].join("\n");
}

/** A Lean-safe theorem name: unique by position, readable by the function's and property's names. */
export function theoremName(index: number, fn: string, property: string): string {
  return `t${index}_${fn}_${property}`.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface EmittedTheorem {
  readonly function: string;
  readonly property: string;
  readonly name: string;
  /** 1-based lines of the theorem in the emitted file, inclusive. */
  readonly from: number;
  readonly to: number;
}

export interface Emitted {
  readonly source: string;
  readonly theorems: readonly EmittedTheorem[];
  /** Properties the emitter could not state, with why. */
  readonly skipped: readonly {
    readonly function: string;
    readonly property: string;
    readonly reason: string;
  }[];
}

/** The whole file: structures, definitions, one theorem per property, then any extra lines (translation checks). */
export function emitModule(
  module: SubsetModule,
  properties: readonly { readonly function: string; readonly property: NamedProperty }[],
  extra: readonly string[] = [],
): Emitted {
  const parts: string[] = [
    "-- Generated by Eutaxy's first-party engine from the annotated module; the theorems are its properties.",
    "set_option linter.unusedSimpArgs false",
    ...module.records.map(emitRecord),
    ...module.functions.map((f) => emitFunction(f, module)),
  ];
  const theorems: EmittedTheorem[] = [];
  const skipped: Emitted["skipped"][number][] = [];
  for (const { function: fn, property } of properties) {
    let body: { text: string; hypotheses: number };
    try {
      body = stated(property.property, module);
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      skipped.push({ function: fn, property: property.name, reason: err.message });
      continue;
    }
    const name = theoremName(theorems.length + skipped.length, fn, property.name);
    const text = `theorem ${name} :\n    ${body.text} := by\n${tactics(module, property.property, body.hypotheses)}`;
    const from = parts.join("\n\n").split("\n").length + 2;
    parts.push(text);
    theorems.push({
      function: fn,
      property: property.name,
      name,
      from,
      to: from + text.split("\n").length - 1,
    });
  }
  parts.push(...extra);
  return { source: `${parts.join("\n\n")}\n`, theorems, skipped };
}

/** A TypeScript value of a subset type as a Lean term, for translation checks. */
export function value(v: unknown, t: SubsetType, module: SubsetModule): string {
  switch (t.kind) {
    case "int":
      if (typeof v !== "number" || !Number.isInteger(v)) fail(`${String(v)} is not an integer`);
      return `(${v} : Int)`;
    case "bool":
      if (typeof v !== "boolean") fail(`${String(v)} is not a boolean`);
      return v ? "true" : "false";
    case "record": {
      const rec = module.records.find((r) => r.name === t.name) ?? fail(`no record ${t.name}`);
      if (typeof v !== "object" || v === null) fail(`${String(v)} is not a record`);
      const o = v as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !rec.fields.some((f) => f.name === k));
      if (extra.length > 0) fail(`${t.name} value has unexpected fields ${extra.join(", ")}`);
      return `({ ${rec.fields.map((f) => `${ident.field(f.name)} := ${value(o[f.name], f.type, module)}`).join(", ")} } : ${ident.record(t.name)})`;
    }
  }
}
