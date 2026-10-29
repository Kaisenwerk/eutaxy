/**
 * SMT-LIB 2 for a module in the subset and the properties on it, as Z3
 * reads it. `number` is the IEEE double (the floating-point theory, so
 * NaN, the infinities and -0 are in every binder's domain and `===` is
 * `fp.eq`, as in JavaScript), `string` a sequence of 16-bit code units,
 * `boolean` Bool, a record a datatype with one constructor, a tagged
 * union a datatype with one constructor per member, a nullable type an
 * option datatype (`none`, `some`), with a name narrowed by a null check
 * bound to its value in the branch the check guards. Each property is one
 * script: the definitions, the binders as constants with what their
 * TypeScript types say beyond their sorts, the precondition asserted, the
 * claim's negation asserted, `check-sat`; an `unsat` is a proof, a model
 * is a candidate counterexample. Values in Z3's models are decoded back to
 * JavaScript values by this module too.
 */

import {
  type Expr,
  isListExpr,
  OutsideSubset,
  type RecordType,
  readArrowBody,
  renameVars,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
  type UnionType,
} from "@eutaxy/prover/reader";
import { type Arrow, describeType, type Property, type SpecType } from "@eutaxy/spec";

export const F64 = "(_ FloatingPoint 11 53)";
export const STR = "(Seq (_ BitVec 16))";

/** A name as an SMT-LIB symbol: simple when it can be, quoted with | otherwise. */
export function symbol(name: string): string {
  // A quoted symbol may hold anything but `|` and `\`: those are escaped as `%7c` and `%5c`, with `%`
  // itself as `%25` first, in every name, so two names never meet in one symbol (a quoted symbol and
  // a simple one spelled alike are the same symbol; a record is named as the compiler prints its
  // type, which may spell any of them).
  const escaped = name.replace(/%/g, "%25").replace(/\\/g, "%5c").replace(/\|/g, "%7c");
  return /^[A-Za-z~!@$%^&*_+=<>.?/-][A-Za-z0-9~!@$%^&*_+=<>.?/-]*$/.test(escaped)
    ? escaped
    : `|${escaped}|`;
}

/** TypeScript names as SMT symbols that cannot clash with each other or with the theories' names. */
export const ident = {
  fn: (name: string) => symbol(`f_${name}`),
  /** The datatype of a record that is no union member, or of a union. */
  record: (name: string) => symbol(`R_${name}`),
  constructor: (name: string) => symbol(`mk_${name}`),
  // A dot, which no TypeScript identifier holds, so selectors of different records never coincide.
  field: (record: string, field: string) => symbol(`fld.${record}.${field}`),
  variable: (name: string) => symbol(`v_${name}`),
  /** The option datatype over a sort, and its constructors and selector. */
  option: (base: string) => symbol(`Opt.${base}`),
  none: (base: string) => symbol(`none.${base}`),
  some: (base: string) => symbol(`some.${base}`),
  val: (base: string) => symbol(`val.${base}`),
};

/** The short name a sort has inside option names: `Opt.F64`, `Opt.R_X`. */
export function sortName(t: SubsetType, module: SubsetModule): string {
  if (t.kind === "list" || t.kind === "nothing") return fail(listsOutside);
  switch (t.kind) {
    case "int":
      return "F64";
    case "bool":
      return "Bool";
    case "string":
      return "Str";
    case "record":
      return ident.record(unionOf(t.name, module) ?? t.name);
    case "union":
      return ident.record(t.name);
    case "nullable":
      return ident.option(sortName(t.inner, module));
    case "null":
      return fail("null has no sort of its own");
  }
}

/** The union a record is a member of, by the record's name. */
function unionOf(record: string, module: SubsetModule): string | undefined {
  return module.records.find((r) => r.name === record)?.union;
}

export function sort(t: SubsetType, module: SubsetModule): string {
  if (t.kind === "list" || t.kind === "nothing") return fail(listsOutside);
  switch (t.kind) {
    case "int":
      return F64;
    case "bool":
      return "Bool";
    case "string":
      return STR;
    case "record":
    case "union":
    case "nullable":
      return sortName(t, module);
    case "null":
      return fail("null has no sort of its own");
  }
}

/** A constructor applied: a bare symbol when there are no arguments. */
function construct(name: string, values: readonly string[]): string {
  return values.length === 0
    ? ident.constructor(name)
    : `(${ident.constructor(name)} ${values.join(" ")})`;
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
  /** Each node's type per scope, computed once: emission asks for types at every level. */
  readonly types: WeakMap<Expr, Map<string, SubsetType>>;
}

function env(module: SubsetModule): Env {
  return {
    module,
    types: new WeakMap(),
    ctx: {
      records: new Map(module.records.map((r) => [r.name, r])),
      signatures: new Map(
        module.functions.map((f) => [f.name, { params: f.params, returns: f.returns }]),
      ),
    },
  };
}

/** Why a list, or an operation on one, is refused here. */
const listsOutside = "arrays are not in this engine's subset (the Lean engine takes them)";

const fail: (message: string) => never = (message) => {
  throw new OutsideSubset(message, 0);
};

/** `Number.isInteger(x)`: finite and equal to its truncation. */
function isIntegerTerm(x: string): string {
  return `(and (not (fp.isNaN ${x})) (not (fp.isInfinite ${x})) (fp.eq ${x} (fp.roundToIntegral RTZ ${x})))`;
}

/** The members of a union, as records, in declaration order. */
function membersOf(union: string, env: Env): RecordType[] {
  const u = env.module.unions.find((x) => x.name === union) ?? fail(`no union ${union}`);
  return u.members.map((m) => env.ctx.records.get(m.record) ?? fail(`no record ${m.record}`));
}

const tester = (constructorSymbol: string): string =>
  constructorSymbol.startsWith("|")
    ? `|is-${constructorSymbol.slice(1)}`
    : `is-${constructorSymbol}`;

/** `===` of two terms of a type, as JavaScript has it. */
function sameAs(a: string, b: string, t: SubsetType, env: Env): string {
  if (t.kind === "list" || t.kind === "nothing") return fail(listsOutside);
  switch (t.kind) {
    case "int":
      return `(fp.eq ${a} ${b})`;
    case "bool":
    case "string":
      return `(= ${a} ${b})`;
    case "nullable": {
      const base = sortName(t.inner, env.module);
      return `(ite (and (${tester(ident.some(base))} ${a}) (${tester(ident.some(base))} ${b})) ${sameAs(`(${ident.val(base)} ${a})`, `(${ident.val(base)} ${b})`, t.inner, env)} (and (${tester(ident.none(base))} ${a}) (${tester(ident.none(base))} ${b})))`;
    }
    case "record":
    case "union":
    case "null":
      return fail("=== on records compares references in JavaScript; compare their fields instead");
  }
}

/**
 * A term of the expression's type, or of `expected` where one is given:
 * `null` and a non-null value become the option's constructors where a
 * nullable is expected, and a member record is already of its union's sort.
 */
export function term(
  e: Expr,
  scope: ReadonlyMap<string, SubsetType>,
  env: Env,
  expected?: SubsetType,
): string {
  const t = (x: Expr, want?: SubsetType) => term(x, scope, env, want);
  if (isListExpr(e)) return fail(listsOutside);
  // A node's type depends on the scope it is typed in (narrowing), so the memo is keyed by both.
  const typed = (x: Expr): SubsetType => {
    const key = JSON.stringify([...scope]);
    let byScope = env.types.get(x);
    if (!byScope) {
      byScope = new Map();
      env.types.set(x, byScope);
    }
    let found = byScope.get(key);
    if (!found) {
      found = typeOf(x, scope, env.ctx, fail);
      byScope.set(key, found);
    }
    return found;
  };
  // A value where `want` is expected: a conditional, a let or a narrowing produce the expected sort
  // themselves; anything else is wrapped in `some` when a nullable is wanted and the value is not one.
  const coerce = (x: Expr, want: SubsetType): string => {
    if (x.kind === "cond" || x.kind === "let" || x.kind === "narrow" || x.kind === "null")
      return t(x, want);
    const actual = typed(x);
    const inner = t(x, want);
    if (want.kind === "nullable" && actual.kind !== "nullable" && actual.kind !== "null")
      return `(${ident.some(sortName(want.inner, env.module))} ${inner})`;
    return inner;
  };
  switch (e.kind) {
    case "int":
      return numberTerm(Number(e.value));
    case "bool":
      return e.value ? "true" : "false";
    case "string":
      return stringTerm(e.value);
    case "null":
      if (expected?.kind !== "nullable") fail("null where no nullable type is expected");
      return ident.none(sortName(expected.inner, env.module));
    case "var":
      return ident.variable(e.name);
    case "narrow": {
      const nt = scope.get(e.name);
      if (nt?.kind !== "nullable") fail(`${e.name} is narrowed but is not a nullable`);
      const base = sortName(nt.inner, env.module);
      const inner = new Map(scope);
      inner.set(e.name, nt.inner);
      return `(let ((${ident.variable(e.name)} (${ident.val(base)} ${ident.variable(e.name)}))) ${term(e.body, inner, env, expected)})`;
    }
    case "neg":
      return `(fp.neg ${t(e.operand)})`;
    case "not":
      return `(not ${t(e.operand)})`;
    case "isInteger":
      return isIntegerTerm(t(e.operand));
    case "binary": {
      const lt = typed(e.left);
      const rt = typed(e.right);
      switch (e.op) {
        case "+":
          return lt.kind === "string"
            ? `(seq.++ ${t(e.left)} ${t(e.right)})`
            : `(fp.add RNE ${t(e.left)} ${t(e.right)})`;
        case "-":
          return `(fp.sub RNE ${t(e.left)} ${t(e.right)})`;
        case "*":
          return `(fp.mul RNE ${t(e.left)} ${t(e.right)})`;
        case "<":
          return `(fp.lt ${t(e.left)} ${t(e.right)})`;
        case "<=":
          return `(fp.leq ${t(e.left)} ${t(e.right)})`;
        case ">":
          return `(fp.gt ${t(e.left)} ${t(e.right)})`;
        case ">=":
          return `(fp.geq ${t(e.left)} ${t(e.right)})`;
        case "===":
        case "!==": {
          let eq: string;
          if (lt.kind === "null" || rt.kind === "null") {
            // Against null: whether the nullable side is none.
            const side = lt.kind === "null" ? e.right : e.left;
            const st = lt.kind === "null" ? rt : lt;
            if (st.kind !== "nullable")
              fail("a comparison with null of something that is not nullable");
            eq = `(${tester(ident.none(sortName(st.inner, env.module)))} ${t(side)})`;
          } else if (lt.kind === "nullable" && rt.kind !== "nullable") {
            const base = sortName(lt.inner, env.module);
            eq = `(and (${tester(ident.some(base))} ${t(e.left)}) ${sameAs(`(${ident.val(base)} ${t(e.left)})`, t(e.right), lt.inner, env)})`;
          } else if (rt.kind === "nullable" && lt.kind !== "nullable") {
            const base = sortName(rt.inner, env.module);
            eq = `(and (${tester(ident.some(base))} ${t(e.right)}) ${sameAs(t(e.left), `(${ident.val(base)} ${t(e.right)})`, rt.inner, env)})`;
          } else eq = sameAs(t(e.left), t(e.right), lt, env);
          return e.op === "===" ? eq : `(not ${eq})`;
        }
        case "&&":
          return `(and ${t(e.left)} ${t(e.right)})`;
        case "||":
          return `(or ${t(e.left)} ${t(e.right)})`;
      }
      break;
    }
    case "cond": {
      // Both branches of one sort: the expected one, or what the branches share.
      const want = expected ?? typed(e);
      return `(ite ${t(e.test)} ${coerce(e.ifTrue, want)} ${coerce(e.ifFalse, want)})`;
    }
    case "call": {
      const sig = env.ctx.signatures.get(e.callee) ?? fail(`no signature for ${e.callee}`);
      const args = e.args.map((a, i) =>
        coerce(a, (sig.params[i] as (typeof sig.params)[number]).type),
      );
      return args.length === 0 ? ident.fn(e.callee) : `(${ident.fn(e.callee)} ${args.join(" ")})`;
    }
    case "field": {
      const o = typed(e.object);
      const obj = t(e.object);
      if (o.kind === "union") {
        // The field every member has: read from whichever member the value is.
        const members = membersOf(o.name, env);
        return members.reduceRight<string | undefined>((rest, m) => {
          const read = `(${ident.field(m.name, e.field)} ${obj})`;
          return rest === undefined
            ? read
            : `(ite (${tester(ident.constructor(m.name))} ${obj}) ${read} ${rest})`;
        }, undefined) as string;
      }
      if (o.kind !== "record") fail(`field ${e.field} read from a ${o.kind}`);
      return `(${ident.field(o.name, e.field)} ${obj})`;
    }
    case "record": {
      const type = typed(e);
      if (type.kind !== "record") fail("a record literal of no record type");
      const rec = env.ctx.records.get(type.name) ?? fail(`no record ${type.name}`);
      // Fields in the declaration's order, whatever order the literal wrote them in.
      const values = rec.fields.map((f) => {
        const given =
          e.fields.find((x) => x.name === f.name) ?? fail(`${type.name} literal without ${f.name}`);
        return coerce(given.value, f.type);
      });
      return construct(type.name, values);
    }
    case "let": {
      const inner = new Map(scope);
      const bound = e.type ?? typed(e.value);
      inner.set(e.name, bound);
      const value = e.type ? coerce(e.value, e.type) : t(e.value);
      return `(let ((${ident.variable(e.name)} ${value})) ${term(e.body, inner, env, expected)})`;
    }
  }
}

export function emitFunction(f: SubsetFunction, module: SubsetModule): string {
  const e = env(module);
  const scope = new Map(f.params.map((p) => [p.name, p.type]));
  const params = f.params
    .map((p) => `(${ident.variable(p.name)} ${sort(p.type, module)})`)
    .join(" ");
  // The body as a value of the declared return type (`coerce` is local to `term`; the rule is repeated).
  const body = (() => {
    const b = f.body;
    if (b.kind === "cond" || b.kind === "let" || b.kind === "narrow" || b.kind === "null")
      return term(b, scope, e, f.returns);
    const actual = typeOf(b, scope, e.ctx, fail);
    const inner = term(b, scope, e, f.returns);
    return f.returns.kind === "nullable" && actual.kind !== "nullable" && actual.kind !== "null"
      ? `(${ident.some(sortName(f.returns.inner, module))} ${inner})`
      : inner;
  })();
  return `(define-fun ${ident.fn(f.name)} (${params}) ${sort(f.returns, module)}\n  ${body})`;
}

/**
 * An option sort over every sort the module could mention: the primitives,
 * every record that is no union member, every union. A body may join a
 * value with `null` in a `const` that no signature shows, so nothing is
 * left to discovery.
 */
function optionSorts(module: SubsetModule): Map<string, SubsetType> {
  const out = new Map<string, SubsetType>();
  const bases: SubsetType[] = [
    { kind: "int" },
    { kind: "bool" },
    { kind: "string" },
    ...module.records
      .filter((r) => r.union === undefined)
      .map((r): SubsetType => ({ kind: "record", name: r.name })),
    ...module.unions.map((u): SubsetType => ({ kind: "union", name: u.name })),
  ];
  for (const b of bases) out.set(sortName(b, module), b);
  return out;
}

/**
 * Every datatype in one declaration, so records, unions and options may
 * refer to one another in any order: a record is one constructor, a union
 * one per member, an option `none` and `some` over its base sort.
 */
export function emitDatatypes(module: SubsetModule): string {
  const plain = module.records.filter((r) => r.union === undefined);
  const unions = module.unions;
  const options = optionSorts(module);
  const names = [
    ...plain.map((r) => ident.record(r.name)),
    ...unions.map((u) => ident.record(u.name)),
    ...[...options.keys()].map((base) => ident.option(base)),
  ];
  if (names.length === 0) return "";
  const constructorOf = (r: RecordType): string =>
    `(${ident.constructor(r.name)}${r.fields.map((f) => ` (${ident.field(r.name, f.name)} ${sort(f.type, module)})`).join("")})`;
  const bodies = [
    ...plain.map((r) => `(${constructorOf(r)})`),
    ...unions.map(
      (u) =>
        `(${u.members.map((m) => constructorOf(module.records.find((r) => r.name === m.record) as RecordType)).join(" ")})`,
    ),
    ...[...options].map(
      ([base, inner]) =>
        `((${ident.none(base)}) (${ident.some(base)} (${ident.val(base)} ${sort(inner, module)})))`,
    ),
  ];
  return `(declare-datatypes (${names.map((n) => `(${n} 0)`).join(" ")}) (${bodies.join(" ")}))`;
}

/**
 * The subset type a binder ranges over, or `OutsideSubset`: `number` is
 * the double, a union of string literals is a string (constrained to the
 * literals in the script), a record is the module's datatype of that
 * name, `T | null` the option over `T`, a union of records the declared
 * union whose members match. Bigint and what the reader could not read
 * are outside.
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
    case "union": {
      const nulls = t.members.filter((m) => m.kind === "null");
      if (t.members.some((m) => m.kind === "undefined"))
        fail(`binder ${name} over ${describeType(t)}: undefined is not in the subset (null is)`);
      const rest = t.members.filter((m) => m.kind !== "null");
      let inner: SubsetType;
      if (rest.every((m) => m.kind === "literal" && typeof m.value === "string"))
        inner = { kind: "string" };
      else if (rest.every((m) => m.kind === "literal" && typeof m.value === "boolean"))
        inner = { kind: "bool" };
      else if (rest.length === 1) inner = binderType(name, rest[0] as SpecType, module);
      else if (rest.every((m) => m.kind === "record")) {
        const union = findUnion(rest as readonly Extract<SpecType, { kind: "record" }>[], module);
        if (!union)
          fail(
            `binder ${name} over ${describeType(t)}: no union the module declares has these members`,
          );
        inner = { kind: "union", name: union.name };
      } else fail(`binder ${name} over ${describeType(t)}: a union the subset does not read`);
      return nulls.length > 0 ? { kind: "nullable", inner } : inner;
    }
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
    case "array":
      fail(`binder ${name} over ${describeType(t)}: arrays are not in the engine's subset yet`);
      break;
    case "unknown":
      fail(`binder ${name} over ${t.text}, which the reader could not read`);
  }
}

/** The declared union whose members carry these tags with these fields, if any. */
function findUnion(
  members: readonly Extract<SpecType, { kind: "record" }>[],
  module: SubsetModule,
): UnionType | undefined {
  return module.unions.find((u) => {
    if (u.members.length !== members.length) return false;
    return u.members.every((m) => {
      const rec = module.records.find((r) => r.name === m.record);
      if (!rec) return false;
      return members.some(
        (sm) =>
          sm.fields.length === rec.fields.length &&
          sm.fields.every((f) => rec.fields.some((rf) => rf.name === f.name)) &&
          sm.fields.some(
            (f) => f.name === u.tag && f.type.kind === "literal" && f.type.value === m.tag,
          ),
      );
    });
  });
}

/**
 * What a binder's subset type says that its sort does not: a member record
 * is its own constructor, a union's members carry their tags, and so on
 * into fields and under an option. Undefined when the sort says it all.
 */
export function wellFormed(
  target: string,
  t: SubsetType,
  module: SubsetModule,
): string | undefined {
  switch (t.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
      return undefined;
    case "nullable": {
      const base = sortName(t.inner, module);
      const inner = wellFormed(`(${ident.val(base)} ${target})`, t.inner, module);
      return inner === undefined
        ? undefined
        : `(or (${tester(ident.none(base))} ${target}) ${inner})`;
    }
    case "record": {
      const rec = module.records.find((r) => r.name === t.name);
      if (!rec) return undefined;
      const parts: string[] = [];
      if (rec.union !== undefined) parts.push(`(${tester(ident.constructor(rec.name))} ${target})`);
      for (const f of rec.fields) {
        const read = `(${ident.field(rec.name, f.name)} ${target})`;
        if (f.literal !== undefined)
          parts.push(
            typeof f.literal === "string"
              ? `(= ${read} ${stringTerm(f.literal)})`
              : `(= ${read} ${f.literal ? "true" : "false"})`,
          );
        const inner = wellFormed(read, f.type, module);
        if (inner !== undefined) parts.push(inner);
      }
      return parts.length === 0
        ? undefined
        : parts.length === 1
          ? parts[0]
          : `(and ${parts.join(" ")})`;
    }
    case "union": {
      const u = module.unions.find((x) => x.name === t.name);
      if (!u) return undefined;
      const cases = u.members.map((m) => {
        const inner = wellFormed(target, { kind: "record", name: m.record }, module);
        return inner ?? `(${tester(ident.constructor(m.record))} ${target})`;
      });
      return `(or ${cases.join(" ")})`;
    }
  }
}

/**
 * What a binder's TypeScript type says beyond its sort: a literal, or a
 * union of literals (with or without null), admits only those values,
 * which the solver must be told, since the sort alone would let it pick
 * any string or number.
 */
export function domainConstraint(
  symbolName: string,
  t: SpecType,
  subset: SubsetType,
  module: SubsetModule,
): string | undefined {
  const literal = (target: string, v: string | number | boolean): string =>
    typeof v === "string"
      ? `(= ${target} ${stringTerm(v)})`
      : typeof v === "number"
        ? `(fp.eq ${target} ${numberTerm(v)})`
        : `(= ${target} ${v ? "true" : "false"})`;
  const literals: (string | number | boolean)[] = [];
  let withNull = false;
  if (t.kind === "literal") literals.push(t.value);
  else if (t.kind === "union") {
    for (const m of t.members) {
      if (m.kind === "literal") literals.push(m.value);
      else if (m.kind === "null") withNull = true;
      else return undefined;
    }
  } else return undefined;
  if (literals.length === 0) return undefined;
  const over = (target: string) => {
    const alternatives = literals.map((v) => literal(target, v));
    return alternatives.length === 1
      ? (alternatives[0] as string)
      : `(or ${alternatives.join(" ")})`;
  };
  if (subset.kind === "nullable") {
    const base = sortName(subset.inner, module);
    const some = `(and (${tester(ident.some(base))} ${symbolName}) ${over(`(${ident.val(base)} ${symbolName})`)})`;
    return withNull ? `(or (${tester(ident.none(base))} ${symbolName}) ${some})` : some;
  }
  return over(symbolName);
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
  const datatypes = emitDatatypes(module);
  return [
    ";; Generated by Eutaxy's first-party SMT engine from the module and its spec file.",
    "(set-option :produce-models true)",
    ...(datatypes === "" ? [] : [datatypes]),
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
    ...binders.map((b) => `(declare-const ${b.symbol} ${sort(b.type, module)})`),
    // What a binder's subset type says that its sort does not: which member of a union, which tags.
    ...binders.flatMap((b) => {
      const c = wellFormed(b.symbol, b.type, module);
      return c === undefined ? [] : [`(assert ${c})`];
    }),
    ...property.binders.flatMap((b, i) => {
      const c = domainConstraint(
        (binders[i] as (typeof binders)[number]).symbol,
        b.type,
        types[i] as SubsetType,
        module,
      );
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
  if (t.kind === "list" || t.kind === "nothing") return fail(listsOutside);
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
    case "nullable": {
      const base = sortName(t.inner, module);
      return v === null ? ident.none(base) : `(${ident.some(base)} ${value(v, t.inner, module)})`;
    }
    case "union": {
      const u = module.unions.find((x) => x.name === t.name) ?? fail(`no union ${t.name}`);
      if (typeof v !== "object" || v === null) fail(`${String(v)} is not a ${t.name}`);
      const tag = (v as Record<string, unknown>)[u.tag];
      const member =
        u.members.find((m) => m.tag === tag) ?? fail(`${t.name} value with tag ${String(tag)}`);
      return value(v, { kind: "record", name: member.record }, module);
    }
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
    case "null":
      return fail("a value of type null");
  }
}

/** Equality of two terms of a type, as JavaScript would have it: `fp.eq` on numbers, field by field on records. */
export function equal(a: string, b: string, t: SubsetType, module: SubsetModule): string {
  if (t.kind === "list" || t.kind === "nothing") return fail(listsOutside);
  switch (t.kind) {
    case "int":
      return `(fp.eq ${a} ${b})`;
    case "bool":
    case "string":
      return `(= ${a} ${b})`;
    case "nullable": {
      const base = sortName(t.inner, module);
      return `(ite (and (${tester(ident.some(base))} ${a}) (${tester(ident.some(base))} ${b})) ${equal(`(${ident.val(base)} ${a})`, `(${ident.val(base)} ${b})`, t.inner, module)} (and (${tester(ident.none(base))} ${a}) (${tester(ident.none(base))} ${b})))`;
    }
    case "union": {
      const u = module.unions.find((x) => x.name === t.name) ?? fail(`no union ${t.name}`);
      const cases = u.members.map(
        (m) =>
          `(and (${tester(ident.constructor(m.record))} ${a}) (${tester(ident.constructor(m.record))} ${b}) ${equal(a, b, { kind: "record", name: m.record }, module)})`,
      );
      return `(or ${cases.join(" ")})`;
    }
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
    case "null":
      return fail("equality at type null");
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
    case "nullable": {
      const base = sortName(t.inner, module);
      if (x === ident.none(base)) return null;
      if (Array.isArray(x) && x[0] === ident.some(base) && x.length === 2)
        return decode(x[1] as SExpr, t.inner, module);
      throw new UnreadableModel(`not a ${describeSubset(t)}: ${show(x)}`);
    }
    case "union": {
      const u = module.unions.find((y) => y.name === t.name);
      if (!u) throw new UnreadableModel(`no union ${t.name}`);
      const head = Array.isArray(x) ? x[0] : x;
      const member = u.members.find((m) => ident.constructor(m.record) === head);
      if (!member) throw new UnreadableModel(`not a ${t.name}: ${show(x)}`);
      return decode(x, { kind: "record", name: member.record }, module);
    }
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
    case "null":
      throw new UnreadableModel("a value of type null");
  }
}

function describeSubset(t: SubsetType): string {
  return t.kind === "nullable"
    ? `${describeSubset(t.inner)} | null`
    : t.kind === "record" || t.kind === "union"
      ? t.name
      : t.kind;
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
