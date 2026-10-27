/**
 * SMT-LIB 2 for a module in the subset and the properties on it, as Z3
 * reads it. `number` is the IEEE double (the floating-point theory, so
 * NaN, the infinities and -0 are in every binder's domain and `===` is
 * `fp.eq`, as in JavaScript), `string` a sequence of 16-bit code units,
 * a record a datatype with one constructor, `boolean` Bool. Each property
 * is one script: the definitions, the binders as constants with what
 * their TypeScript types say beyond their sorts, the precondition
 * asserted, the claim's negation asserted, `check-sat`; an `unsat` is a
 * proof, a model is a candidate counterexample. Values in Z3's models are
 * decoded back to JavaScript values by this module too.
 */

import {
  type Expr,
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

export const F64 = "(_ FloatingPoint 11 53)";
export const STR = "(Seq (_ BitVec 16))";

/** A name as an SMT-LIB symbol: simple when it can be, quoted with | otherwise. */
export function symbol(name: string): string {
  return /^[A-Za-z~!@$%^&*_+=<>.?/-][A-Za-z0-9~!@$%^&*_+=<>.?/-]*$/.test(name)
    ? name
    : `|${name.replace(/[|\\]/g, "_")}|`;
}

/** TypeScript names as SMT symbols that cannot clash with each other or with the theories' names. */
export const ident = {
  fn: (name: string) => symbol(`f_${name}`),
  record: (name: string) => symbol(`R_${name}`),
  constructor: (name: string) => symbol(`mk_${name}`),
  // A dot, which no TypeScript identifier holds, so selectors of different records never coincide.
  field: (record: string, field: string) => symbol(`fld.${record}.${field}`),
  variable: (name: string) => symbol(`v_${name}`),
};

export function sort(t: SubsetType): string {
  switch (t.kind) {
    case "int":
      return F64;
    case "bool":
      return "Bool";
    case "string":
      return STR;
    case "record":
      return ident.record(t.name);
  }
}

export function emitRecord(r: RecordType): string {
  const fields = r.fields.map((f) => ` (${ident.field(r.name, f.name)} ${sort(f.type)})`).join("");
  return `(declare-datatype ${ident.record(r.name)} ((${ident.constructor(r.name)}${fields})))`;
}

/** A constructor applied: a bare symbol when the record has no fields. */
function construct(record: string, values: readonly string[]): string {
  return values.length === 0
    ? ident.constructor(record)
    : `(${ident.constructor(record)} ${values.join(" ")})`;
}

/** A double as a floating-point literal. */
export function numberTerm(n: number): string {
  if (Number.isNaN(n)) return "(_ NaN 11 53)";
  if (n === Number.POSITIVE_INFINITY) return "(_ +oo 11 53)";
  if (n === Number.NEGATIVE_INFINITY) return "(_ -oo 11 53)";
  if (Object.is(n, -0)) return "(_ -zero 11 53)";
  if (n === 0) return "(_ +zero 11 53)";
  // Exact bits, so a value round-trips whatever its magnitude.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  const bits = view.getBigUint64(0);
  const sign = (bits >> 63n) & 1n;
  const exponent = (bits >> 52n) & 0x7ffn;
  const significand = bits & ((1n << 52n) - 1n);
  return `(fp #b${sign} #b${exponent.toString(2).padStart(11, "0")} #b${significand.toString(2).padStart(52, "0")})`;
}

/** A JavaScript string as a sequence of its UTF-16 code units. */
export function stringTerm(s: string): string {
  if (s.length === 0) return `(as seq.empty ${STR})`;
  const units: string[] = [];
  for (let i = 0; i < s.length; i++)
    units.push(`(seq.unit #x${s.charCodeAt(i).toString(16).padStart(4, "0")})`);
  return units.length === 1 ? (units[0] as string) : `(seq.++ ${units.join(" ")})`;
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

/** `Number.isInteger(x)`: finite and equal to its truncation. */
function isIntegerTerm(x: string): string {
  return `(and (not (fp.isNaN ${x})) (not (fp.isInfinite ${x})) (fp.eq ${x} (fp.roundToIntegral RTZ ${x})))`;
}

/** A term of the expression's type. */
export function term(e: Expr, scope: ReadonlyMap<string, SubsetType>, env: Env): string {
  const t = (x: Expr) => term(x, scope, env);
  switch (e.kind) {
    case "int":
      return numberTerm(Number(e.value));
    case "bool":
      return e.value ? "true" : "false";
    case "string":
      return stringTerm(e.value);
    case "var":
      return ident.variable(e.name);
    case "neg":
      return `(fp.neg ${t(e.operand)})`;
    case "not":
      return `(not ${t(e.operand)})`;
    case "isInteger":
      return isIntegerTerm(t(e.operand));
    case "binary": {
      const lt = typeOf(e.left, scope, env.ctx, fail);
      const l = t(e.left);
      const r = t(e.right);
      switch (e.op) {
        case "+":
          return lt.kind === "string" ? `(seq.++ ${l} ${r})` : `(fp.add RNE ${l} ${r})`;
        case "-":
          return `(fp.sub RNE ${l} ${r})`;
        case "*":
          return `(fp.mul RNE ${l} ${r})`;
        case "<":
          return `(fp.lt ${l} ${r})`;
        case "<=":
          return `(fp.leq ${l} ${r})`;
        case ">":
          return `(fp.gt ${l} ${r})`;
        case ">=":
          return `(fp.geq ${l} ${r})`;
        case "===":
        case "!==": {
          // === on objects compares references in JavaScript; a datatype's = would compare the fields.
          if (lt.kind === "record")
            fail(
              `${e.op} on records compares references in JavaScript; compare their fields instead`,
            );
          const eq = lt.kind === "int" ? `(fp.eq ${l} ${r})` : `(= ${l} ${r})`;
          return e.op === "===" ? eq : `(not ${eq})`;
        }
        case "&&":
          return `(and ${l} ${r})`;
        case "||":
          return `(or ${l} ${r})`;
      }
      break;
    }
    case "cond":
      return `(ite ${t(e.test)} ${t(e.ifTrue)} ${t(e.ifFalse)})`;
    case "call":
      return e.args.length === 0
        ? ident.fn(e.callee)
        : `(${ident.fn(e.callee)} ${e.args.map(t).join(" ")})`;
    case "field": {
      const o = typeOf(e.object, scope, env.ctx, fail);
      if (o.kind !== "record") fail(`field ${e.field} read from a ${o.kind}`);
      return `(${ident.field(o.name, e.field)} ${t(e.object)})`;
    }
    case "record": {
      const type = typeOf(e, scope, env.ctx, fail);
      if (type.kind !== "record") fail("a record literal of no record type");
      const rec = env.ctx.records.get(type.name) ?? fail(`no record ${type.name}`);
      // Fields in the declaration's order, whatever order the literal wrote them in.
      const values = rec.fields.map((f) => {
        const given =
          e.fields.find((x) => x.name === f.name) ?? fail(`${type.name} literal without ${f.name}`);
        return t(given.value);
      });
      return construct(type.name, values);
    }
    case "let": {
      const inner = new Map(scope);
      inner.set(e.name, typeOf(e.value, scope, env.ctx, fail));
      return `(let ((${ident.variable(e.name)} ${t(e.value)})) ${term(e.body, inner, env)})`;
    }
  }
}

export function emitFunction(f: SubsetFunction, module: SubsetModule): string {
  const e = env(module);
  const scope = new Map(f.params.map((p) => [p.name, p.type]));
  const params = f.params.map((p) => `(${ident.variable(p.name)} ${sort(p.type)})`).join(" ");
  return `(define-fun ${ident.fn(f.name)} (${params}) ${sort(f.returns)}\n  ${term(f.body, scope, e)})`;
}

/**
 * The subset type a binder ranges over, or `OutsideSubset`: `number` is
 * the double, a union of string literals is a string (constrained to the
 * literals in the script), a record is the module's datatype of that
 * name. Nullable types, tagged unions, bigint and what the reader could
 * not read are outside for now.
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

/**
 * What a binder's TypeScript type says beyond its sort: a literal, or a
 * union of literals, admits only those values, which the solver must be
 * told, since the sort alone would let it pick any string or number.
 */
export function domainConstraint(symbolName: string, t: SpecType): string | undefined {
  const literal = (v: string | number | boolean): string =>
    typeof v === "string"
      ? `(= ${symbolName} ${stringTerm(v)})`
      : typeof v === "number"
        ? `(fp.eq ${symbolName} ${numberTerm(v)})`
        : `(= ${symbolName} ${v ? "true" : "false"})`;
  if (t.kind === "literal") return literal(t.value);
  if (t.kind === "union" && t.members.every((m) => m.kind === "literal")) {
    const alternatives = t.members.map((m) =>
      literal((m as { value: string | number | boolean }).value),
    );
    return alternatives.length === 1 ? alternatives[0] : `(or ${alternatives.join(" ")})`;
  }
  return undefined;
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
  } catch (err) {
    if (!(err instanceof OutsideSubset)) throw err;
    throw new OutsideSubset(`${what} (spec file line ${arrow.line}): ${err.message}`, arrow.line);
  }
}

/** The definitions every script of the module starts with: datatypes, then functions, callees first. */
export function prelude(module: SubsetModule): string {
  return [
    ";; Generated by Eutaxy's first-party SMT engine from the module and its spec file.",
    "(set-option :produce-models true)",
    ...module.records.map(emitRecord),
    ...module.functions.map((f) => emitFunction(f, module)),
  ].join("\n");
}

export interface PropertyScript {
  readonly script: string;
  /** The binders' SMT names and types, in order, for reading a model back. */
  readonly binders: readonly {
    readonly name: string;
    readonly symbol: string;
    readonly type: SubsetType;
  }[];
}

/**
 * One property's script: the binders as constants, what their types say
 * beyond their sorts, the precondition asserted, the claim's negation
 * asserted. `unsat` proves the claim; `sat` comes with the binders' values.
 */
export function propertyScript(property: Property, module: SubsetModule): PropertyScript {
  if (property.kind !== "forall" || !property.ensures) fail("not a forall property");
  const e = env(module);
  const types = property.binders.map((b) => binderType(b.name, b.type, module));
  const binders = property.binders.map((b, i) => ({
    name: b.name,
    symbol: ident.variable(b.name),
    type: types[i] as SubsetType,
  }));
  const lines = [
    prelude(module),
    ...binders.map((b) => `(declare-const ${b.symbol} ${sort(b.type)})`),
    ...property.binders.flatMap((b, i) => {
      const c = domainConstraint((binders[i] as (typeof binders)[number]).symbol, b.type);
      return c === undefined ? [] : [`(assert ${c})`];
    }),
    ...(property.when ? [`(assert ${arrowTerm(property.when, "when", property, types, e)})`] : []),
    `(assert (not ${arrowTerm(property.ensures, "ensures", property, types, e)}))`,
    "(check-sat)",
    ...(binders.length > 0 ? [`(get-value (${binders.map((b) => b.symbol).join(" ")}))`] : []),
    "(get-info :reason-unknown)",
  ];
  return { script: `${lines.join("\n")}\n`, binders };
}

/** A TypeScript value of a subset type as a term, for translation checks. */
export function value(v: unknown, t: SubsetType, module: SubsetModule): string {
  switch (t.kind) {
    case "int":
      if (typeof v !== "number") fail(`${String(v)} is not a number`);
      return numberTerm(v);
    case "bool":
      if (typeof v !== "boolean") fail(`${String(v)} is not a boolean`);
      return v ? "true" : "false";
    case "string":
      if (typeof v !== "string") fail(`${String(v)} is not a string`);
      return stringTerm(v);
    case "record": {
      const rec = module.records.find((r) => r.name === t.name) ?? fail(`no record ${t.name}`);
      if (typeof v !== "object" || v === null) fail(`${String(v)} is not a record`);
      const o = v as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !rec.fields.some((f) => f.name === k));
      if (extra.length > 0) fail(`${t.name} value has unexpected fields ${extra.join(", ")}`);
      return construct(
        t.name,
        rec.fields.map((f) => value(o[f.name], f.type, module)),
      );
    }
  }
}

/** Equality of two terms of a type, as JavaScript would have it: `fp.eq` on numbers, field by field on records. */
export function equal(a: string, b: string, t: SubsetType, module: SubsetModule): string {
  switch (t.kind) {
    case "int":
      return `(fp.eq ${a} ${b})`;
    case "bool":
    case "string":
      return `(= ${a} ${b})`;
    case "record": {
      const rec = module.records.find((r) => r.name === t.name) ?? fail(`no record ${t.name}`);
      const fields = rec.fields.map((f) =>
        equal(
          `(${ident.field(t.name, f.name)} ${a})`,
          `(${ident.field(t.name, f.name)} ${b})`,
          f.type,
          module,
        ),
      );
      if (fields.length === 0) return "true";
      return fields.length === 1 ? (fields[0] as string) : `(and ${fields.join(" ")})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading Z3's answers.

export type SExpr = string | readonly SExpr[];

/** Z3's output as S-expressions and atoms, in order. */
export function parseSExprs(text: string): SExpr[] {
  const out: SExpr[] = [];
  const stack: SExpr[][] = [];
  let i = 0;
  const push = (x: SExpr) => {
    const top = stack[stack.length - 1];
    if (top) top.push(x);
    else out.push(x);
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      stack.push([]);
      i++;
      continue;
    }
    if (c === ")") {
      const done = stack.pop();
      if (done) push(done);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (text[j] === '"') break;
        else s += text[j++];
      }
      push(`"${s}"`);
      i = j + 1;
      continue;
    }
    if (c === "|") {
      const j = text.indexOf("|", i + 1);
      push(text.slice(i, j < 0 ? text.length : j + 1));
      i = j < 0 ? text.length : j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j] as string)) j++;
    push(text.slice(i, j));
    i = j;
  }
  while (stack.length > 0) {
    const done = stack.pop();
    if (done) push(done);
  }
  return out;
}

/** Thrown when a model value is not of the shape the type calls for. */
export class UnreadableModel extends Error {}

const bitsOf = (atom: string): bigint =>
  atom.startsWith("#b") ? BigInt(`0b${atom.slice(2)}`) : BigInt(`0x${atom.slice(2)}`);

/** A model value of the type as a JavaScript value. */
export function decode(x: SExpr, t: SubsetType, module: SubsetModule): unknown {
  switch (t.kind) {
    case "bool":
      if (x === "true") return true;
      if (x === "false") return false;
      throw new UnreadableModel(`not a boolean: ${show(x)}`);
    case "int": {
      if (Array.isArray(x) && x[0] === "_") {
        const special = x[1];
        if (special === "NaN") return Number.NaN;
        if (special === "+oo") return Number.POSITIVE_INFINITY;
        if (special === "-oo") return Number.NEGATIVE_INFINITY;
        if (special === "+zero") return 0;
        if (special === "-zero") return -0;
      }
      if (Array.isArray(x) && x[0] === "fp" && x.length === 4) {
        const sign = bitsOf(x[1] as string);
        const exponent = bitsOf(x[2] as string);
        const significand = bitsOf(x[3] as string);
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, (sign << 63n) | (exponent << 52n) | significand);
        return view.getFloat64(0);
      }
      throw new UnreadableModel(`not a double: ${show(x)}`);
    }
    case "string":
      return decodeString(x);
    case "record": {
      const rec = module.records.find((r) => r.name === t.name);
      if (!rec) throw new UnreadableModel(`no record ${t.name}`);
      if (rec.fields.length === 0 && x === ident.constructor(t.name)) return {};
      if (
        !Array.isArray(x) ||
        x[0] !== ident.constructor(t.name) ||
        x.length !== rec.fields.length + 1
      )
        throw new UnreadableModel(`not a ${t.name}: ${show(x)}`);
      const out: Record<string, unknown> = {};
      rec.fields.forEach((f, i) => {
        out[f.name] = decode(x[i + 1] as SExpr, f.type, module);
      });
      return out;
    }
  }
}

function decodeString(x: SExpr): string {
  if (Array.isArray(x)) {
    if (x[0] === "seq.unit" && typeof x[1] === "string")
      return String.fromCharCode(Number(bitsOf(x[1])));
    if (x[0] === "seq.++") return x.slice(1).map(decodeString).join("");
    if (x[0] === "as" && x[1] === "seq.empty") return "";
    if (x[0] === "_" && x[1] === "seq.empty") return "";
  }
  throw new UnreadableModel(`not a string: ${show(x)}`);
}

function show(x: SExpr): string {
  return typeof x === "string" ? x : `(${x.map(show).join(" ")})`;
}

export interface Answer {
  readonly result: "sat" | "unsat" | "unknown" | "error";
  /** The binders' values when `sat`, by SMT symbol. */
  readonly values: ReadonlyMap<string, SExpr>;
  readonly reason: string;
  /** Every `(error …)` Z3 printed, except the one for a model asked after `unsat`, which the script expects. */
  readonly errors: readonly string[];
}

/** What a property's script came back with. */
export function readAnswer(output: string): Answer {
  const parts = parseSExprs(output);
  const first = parts.find((p) => p === "sat" || p === "unsat" || p === "unknown");
  const errors = parts
    .filter((p): p is readonly SExpr[] => Array.isArray(p) && p[0] === "error")
    .map((e) => show(e))
    .filter((e) => !/model is not available/.test(e));
  const values = new Map<string, SExpr>();
  let reason = "";
  for (const p of parts) {
    if (!Array.isArray(p)) continue;
    if (p[0] === ":reason-unknown" && typeof p[1] === "string") reason = p[1].replace(/^"|"$/g, "");
    if (p.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string"))
      for (const pair of p as readonly (readonly [string, SExpr])[]) values.set(pair[0], pair[1]);
  }
  if (first === undefined)
    return { result: "error", values, reason: errors.join("; ") || output.trim(), errors };
  return { result: first as Answer["result"], values, reason, errors };
}
