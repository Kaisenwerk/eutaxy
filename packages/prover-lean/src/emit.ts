/**
 * Lean 4 for a module in the subset and the properties on it. The
 * module's record types become structures, its functions definitions over
 * `Int`, `Bool` and `String`, each property a theorem whose statement is
 * the claim over its binders, with the precondition as a hypothesis.
 * Booleans stay `Bool` in terms, as in TypeScript, and become propositions
 * with `= true` where a statement needs one; comparisons are `decide`d.
 * Every theorem is closed by one tactic script, so what Lean checks is the
 * statement, not a hand proof.
 */

import {
  type Expr,
  hasLoneSurrogate,
  OutsideSubset,
  type RecordType,
  readArrowBody,
  renameVars,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
} from "@eutaxy/prover/reader";
import { type Arrow, describeType, type Property, type SpecType } from "@eutaxy/spec";

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
    case "string":
      return "String";
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

/** A term of the expression's TypeScript type: `Int`, `Bool`, `String` or a structure. */
export function term(e: Expr, scope: ReadonlyMap<string, SubsetType>, env: Env): string {
  const t = (x: Expr) => term(x, scope, env);
  switch (e.kind) {
    case "int":
      return `(${e.value} : Int)`;
    case "bool":
      return e.value ? "true" : "false";
    case "string":
      return leanString(e.value);
    case "var":
      return ident.variable(e.name);
    case "neg":
      return `(-${t(e.operand)})`;
    case "not":
      return `(!${t(e.operand)})`;
    case "isInteger":
      // Every number is an integer in this engine's model; the operand is still typed.
      typeOf(e.operand, scope, env.ctx, fail);
      return "true";
    case "binary":
      switch (e.op) {
        case "+": {
          const lt = typeOf(e.left, scope, env.ctx, fail);
          return `(${t(e.left)} ${lt.kind === "string" ? "++" : "+"} ${t(e.right)})`;
        }
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

/**
 * The subset type a binder ranges over, or `OutsideSubset`: `number` is
 * `Int` (the engine's integer model, an assumption every PROVEN carries),
 * a union of string literals is `String` (the proof covers every string,
 * more than the type admits), a record is the module's structure of that
 * name. Nullable types, tagged unions, bigint and whatever the reader
 * could not read are outside.
 */
export function binderType(name: string, t: SpecType, module: SubsetModule): SubsetType {
  switch (t.kind) {
    case "number":
      return { kind: "int" };
    case "boolean":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "literal":
      if (typeof t.value === "string") return { kind: "string" };
      if (typeof t.value === "boolean") return { kind: "bool" };
      return { kind: "int" };
    case "bigint":
      // A BigInt passed to a function over number throws on the first mixed operation in JavaScript.
      fail(`binder ${name} over bigint: the subset has no bigint`);
      break;
    case "union":
      if (t.members.every((m) => m.kind === "literal" && typeof m.value === "string"))
        return { kind: "string" };
      if (t.members.some((m) => m.kind === "null" || m.kind === "undefined"))
        fail(
          `binder ${name} over ${describeType(t)}: nullable types are not in the engine's subset yet`,
        );
      fail(`binder ${name} over ${describeType(t)}: unions are not in the engine's subset yet`);
      break;
    case "record":
      if (t.name !== undefined && module.records.some((r) => r.name === t.name))
        return { kind: "record", name: t.name };
      fail(
        `binder ${name} over ${describeType(t)}: ${t.name === undefined ? "an inline record type" : `record type ${t.name} is outside the subset`}`,
      );
      break;
    case "null":
    case "undefined":
      fail(`binder ${name} over ${t.kind}`);
      break;
    case "unknown":
      fail(`binder ${name} over ${t.text}, which the reader could not read`);
  }
}

/** An arrow of the spec file as a Bool term over the binders, its own parameter names renamed to theirs. */
function arrowTerm(
  arrow: Arrow,
  what: "when" | "ensures",
  property: Property,
  types: readonly SubsetType[],
  e: Env,
): string {
  try {
    return arrowTermAt(arrow, what, property, types, e);
  } catch (err) {
    // What the subset refused, located in the spec file.
    if (!(err instanceof OutsideSubset)) throw err;
    throw new OutsideSubset(`${what} (spec file line ${arrow.line}): ${err.message}`, arrow.line);
  }
}

function arrowTermAt(
  arrow: Arrow,
  what: "when" | "ensures",
  property: Property,
  types: readonly SubsetType[],
  e: Env,
): string {
  const binders = property.binders;
  const scope = new Map<string, SubsetType>();
  const names = new Map<string, string>();
  arrow.params.forEach((p, i) => {
    const binder = binders[i];
    const type = types[i];
    if (p === null) fail(`a destructured parameter in ${what}`);
    if (!binder || !type) fail(`${what} takes more parameters than the function has`);
    scope.set(p, type);
    names.set(p, binder.name);
  });
  const aliases = new Map(property.imports.map((i) => [i.local, i.fn]));
  const read = readArrowBody(arrow, scope, e.module, aliases);
  const t = typeOf(read, scope, e.ctx, fail);
  if (t.kind !== "bool")
    fail(`${what} is not boolean (a ${t.kind === "record" ? t.name : t.kind})`);
  const renamed = renameVars(read, names);
  const binderScope = new Map(binders.map((b, i) => [b.name, types[i] as SubsetType]));
  return term(renamed, binderScope, e);
}

/** The proposition a property claims: binders universally quantified, the precondition in front. */
export function statement(property: Property, module: SubsetModule): string {
  return stated(property, module).text;
}

/** The statement and how many hypotheses stand before the claim (the tactic script introduces them by name). */
export function stated(
  property: Property,
  module: SubsetModule,
): { readonly text: string; readonly hypotheses: number } {
  if (property.kind !== "forall" || !property.ensures) fail("not a forall property");
  const e = env(module);
  const types = property.binders.map((b) => binderType(b.name, b.type, module));
  const binders = property.binders
    .map((b, i) => `(${ident.variable(b.name)} : ${leanType(types[i] as SubsetType)})`)
    .join(" ");
  const hyps = property.when
    ? [`(${arrowTerm(property.when, "when", property, types, e)} = true)`]
    : [];
  const claim = `(${arrowTerm(property.ensures, "ensures", property, types, e)} = true)`;
  const body = [...hyps, claim].join(" →\n    ");
  return {
    // A function of no parameters has nothing to quantify over: the proposition stands alone.
    text: binders === "" ? body : `∀ ${binders},\n    ${body}`,
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
    .filter(
      (b) =>
        b.type.kind === "boolean" ||
        (b.type.kind === "literal" && typeof b.type.value === "boolean"),
    )
    .map((b) => ident.variable(b.name));
  const introduced = [...names, ...hyps];
  return [
    ...(introduced.length > 0 ? [`  intro ${introduced.join(" ")}`] : []),
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
  properties: readonly { readonly function: string; readonly property: Property }[],
  extra: readonly string[] = [],
): Emitted {
  const parts: string[] = [
    "-- Generated by Eutaxy's first-party engine from the module and its spec file; the theorems are its properties.",
    "set_option linter.unusedSimpArgs false",
    ...module.records.map(emitRecord),
    ...module.functions.map((f) => emitFunction(f, module)),
  ];
  const theorems: EmittedTheorem[] = [];
  const skipped: Emitted["skipped"][number][] = [];
  for (const { function: fn, property } of properties) {
    let body: { text: string; hypotheses: number };
    try {
      body = stated(property, module);
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      skipped.push({ function: fn, property: property.name, reason: err.message });
      continue;
    }
    const name = theoremName(theorems.length + skipped.length, fn, property.name);
    const text = `theorem ${name} :\n    ${body.text} := by\n${tactics(module, property, body.hypotheses)}`;
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

/**
 * A JavaScript string as a Lean string literal: `"` and `\` escaped, control
 * characters as `\xHH`, everything else written as it is (Lean source is
 * UTF-8). A lone surrogate has no Lean character and is refused.
 */
export function leanString(value: string): string {
  if (hasLoneSurrogate(value))
    fail("a string with a lone surrogate, which Lean's strings cannot hold");
  let out = '"';
  for (const c of value) {
    const code = c.codePointAt(0) as number;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return `${out}"`;
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
    case "string":
      if (typeof v !== "string") fail(`${String(v)} is not a string`);
      return leanString(v);
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
