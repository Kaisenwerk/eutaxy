/**
 * The subset's typing: `typeOf` types an expression in a scope, against
 * the records, unions and callee signatures of a `TypeContext`; `fits` is
 * the subset's assignability (a member where its union is, `null` or the
 * inner type where a nullable is).
 */

import {
  describe,
  type Expr,
  type Field,
  isMember,
  type Param,
  type RecordType,
  type SubsetType,
  type UnionType,
} from "./tree.ts";

/** A union's members among the records known, in the order they were read. */
export function membersIn(union: string, ctx: TypeContext): RecordType[] {
  return [...ctx.records.values()].filter((rec) => isMember(rec, union));
}

const sameType = (a: SubsetType, b: SubsetType): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a value of one type may stand where another is expected: the
 * same type; a member record where its union is; `null`, or the inner
 * type, where a nullable is.
 */
export function fits(actual: SubsetType, expected: SubsetType, ctx: TypeContext): boolean {
  if (sameType(actual, expected)) return true;
  // The element of `[]` is no value at all, so it stands for any; a list fits where its elements do.
  if (actual.kind === "nothing") return true;
  if (actual.kind === "list" && expected.kind === "list")
    return fits(actual.element, expected.element, ctx);
  if (expected.kind === "union")
    return actual.kind === "record" && isMember(ctx.records.get(actual.name), expected.name);
  if (expected.kind === "nullable")
    return (
      actual.kind === "null" ||
      (actual.kind === "nullable"
        ? fits(actual.inner, expected.inner, ctx)
        : fits(actual, expected.inner, ctx))
    );
  return false;
}

/** The type two branches share, or undefined when they share none. */
function join(a: SubsetType, b: SubsetType, ctx: TypeContext): SubsetType | undefined {
  if (fits(a, b, ctx)) return b;
  if (fits(b, a, ctx)) return a;
  if (a.kind === "list" && b.kind === "list") {
    const element = join(a.element, b.element, ctx);
    return element && { kind: "list", element };
  }
  if (a.kind === "record" && b.kind === "record") {
    // Two members of one union join to it; members of several unions in common join to none,
    // since nothing says which (an expected type, where one is given, decides instead).
    const ub = ctx.records.get(b.name)?.unions ?? [];
    const common = (ctx.records.get(a.name)?.unions ?? []).filter((u) => ub.includes(u));
    if (common.length === 1) return { kind: "union", name: common[0] as string };
  }
  if (a.kind === "nullable" && b.kind === "nullable") {
    const inner = join(a.inner, b.inner, ctx);
    return inner && { kind: "nullable", inner };
  }
  if (a.kind === "null" && b.kind !== "null") return { kind: "nullable", inner: b };
  if (b.kind === "null" && a.kind !== "null") return { kind: "nullable", inner: a };
  if (a.kind === "nullable" && b.kind !== "null" && b.kind !== "nullable") {
    const inner = join(a.inner, b, ctx);
    return inner && { kind: "nullable", inner };
  }
  if (b.kind === "nullable" && a.kind !== "null" && a.kind !== "nullable") {
    const inner = join(a, b.inner, ctx);
    return inner && { kind: "nullable", inner };
  }
  return undefined;
}

/** Whether `===` between the two types is in the subset, and on records (references in JavaScript) it is not. */
function comparable(l: SubsetType, r: SubsetType): boolean {
  const base = (t: SubsetType): SubsetType => (t.kind === "nullable" ? t.inner : t);
  if (l.kind === "null" && r.kind === "null") return false;
  if (l.kind === "null") return r.kind === "nullable";
  if (r.kind === "null") return l.kind === "nullable";
  return sameType(base(l), base(r)) && !isReference(base(l));
}

const isReference = (t: SubsetType): boolean =>
  t.kind === "record" || t.kind === "union" || t.kind === "list";

/**
 * The element type of a list expression's type. An operation on an empty
 * array no type is given for (`[].length`, `[].slice(1)`) is refused: an
 * engine could only guess the element type, and such code has a plain
 * value to write instead; `const xs: T[] = []` gives one.
 */
export function elementOf(
  t: SubsetType,
  what: string,
  fail: (message: string) => never,
): SubsetType {
  if (t.kind !== "list") fail(`${what} on a ${describe(t)}, not a list`);
  if (holdsNothing(t))
    fail(`${what} on an empty array of no declared type (annotate it: const xs: T[] = [])`);
  return t.element;
}

/** Whether a type holds the element type of an empty array literal anywhere in it (`[[]]` does). */
function holdsNothing(t: SubsetType): boolean {
  if (t.kind === "nothing") return true;
  if (t.kind === "list") return holdsNothing(t.element);
  if (t.kind === "nullable") return holdsNothing(t.inner);
  return false;
}

/** The scope inside an iteration's callback: the item an element, the index an integer. */
export function iterateScope(
  e: Extract<Expr, { kind: "iterate" }>,
  list: Expr,
  scope: ReadonlyMap<string, SubsetType>,
  ctx: TypeContext,
  fail: (message: string) => never,
): Map<string, SubsetType> {
  const inner = new Map(scope);
  inner.set(e.item, elementOf(typeOf(list, scope, ctx, fail), e.op, fail));
  if (e.index !== undefined) inner.set(e.index, { kind: "int" });
  return inner;
}

/**
 * The scope inside a fold's callback and the accumulator's type: the
 * initial value's, widened once to the body's when the body's holds it.
 * A callback that takes the accumulator apart as a list needs the initial
 * value typed (`xs.reduce((acc, x) => [x, ...acc], [])` does not
 * type-check in TypeScript either).
 */
function foldScope(
  e: Extract<Expr, { kind: "fold" }>,
  list: Expr,
  init: Expr,
  scope: ReadonlyMap<string, SubsetType>,
  ctx: TypeContext,
  fail: (message: string) => never,
): { scope: Map<string, SubsetType>; acc: SubsetType } {
  const item = elementOf(typeOf(list, scope, ctx, fail), "reduce", fail);
  const at = (acc: SubsetType) => new Map([...scope, [e.acc, acc], [e.item, item]]);
  const start = typeOf(init, scope, ctx, fail);
  const body = typeOf(e.body, at(start), ctx, fail);
  if (fits(body, start, ctx)) return { scope: at(start), acc: start };
  if (fits(start, body, ctx) && fits(typeOf(e.body, at(body), ctx, fail), body, ctx))
    return { scope: at(body), acc: body };
  fail(`reduce's callback makes a ${describe(body)} from an accumulator of ${describe(start)}`);
}

/** A function's parameters and return type, for typing calls. */
export interface CalleeSignature {
  readonly params: readonly Param[];
  readonly returns: SubsetType;
}

/** What typing an expression needs to know about its module. */
export interface TypeContext {
  readonly records: ReadonlyMap<string, RecordType>;
  /** The unions read so far, each naming its tag; a live list while a module is being read. */
  readonly unions: readonly UnionType[];
  readonly signatures: ReadonlyMap<string, CalleeSignature>;
}

/** The type of an expression in a scope; records are matched by their fields' names. */
export function typeOf(
  e: Expr,
  scope: ReadonlyMap<string, SubsetType>,
  ctx: TypeContext,
  fail: (message: string) => never,
  /**
   * The type the context declares for `e` (a return type, a const's
   * annotation, a parameter): it decides a conditional whose branches are
   * members of several unions in common, where they alone join to none.
   */
  expected?: SubsetType,
): SubsetType {
  switch (e.kind) {
    case "int":
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "null":
      return { kind: "null" };
    case "var": {
      const t = scope.get(e.name);
      if (!t) fail(`${e.name} is not in scope`);
      return t;
    }
    case "narrow": {
      const t = scope.get(e.name);
      if (!t) fail(`${e.name} is not in scope`);
      if (t.kind !== "nullable")
        fail(`${e.name} is narrowed but is a ${describe(t)}, not a nullable`);
      return typeOf(e.body, new Map([...scope, [e.name, t.inner]]), ctx, fail, expected);
    }
    case "narrowTag": {
      const t = scope.get(e.name);
      if (!t) fail(`${e.name} is not in scope`);
      if (t.kind !== "union")
        fail(`${e.name} is narrowed by a tag but is a ${describe(t)}, not a union`);
      if (!isMember(ctx.records.get(e.member), t.name))
        fail(`${e.member} is not a member of ${t.name}`);
      return typeOf(
        e.body,
        new Map([...scope, [e.name, { kind: "record", name: e.member }]]),
        ctx,
        fail,
        expected,
      );
    }
    case "binary": {
      const l = typeOf(e.left, scope, ctx, fail);
      const r = typeOf(e.right, scope, ctx, fail);
      // `+` joins two strings; every other arithmetic or ordering operator is on integers only
      // (ordering strings compares UTF-16 code units in JavaScript and characters in Lean: not the same).
      if (e.op === "+" && l.kind === "string" && r.kind === "string") return { kind: "string" };
      const arithmetic = ["+", "-", "*", "/", "<", "<=", ">", ">="].includes(e.op);
      if (arithmetic && (l.kind !== "int" || r.kind !== "int"))
        fail(
          `${e.op} on a ${l.kind} and a ${r.kind} (the subset has it on integers${e.op === "+" ? ", and + on two strings" : ""})`,
        );
      if ((e.op === "&&" || e.op === "||") && (l.kind !== "bool" || r.kind !== "bool"))
        fail(`${e.op} on a ${l.kind} and a ${r.kind} (the subset has it on booleans)`);
      if (e.op === "===" || e.op === "!==") {
        // Against null, any nullable; otherwise records and unions are references in JavaScript.
        const againstNull = l.kind === "null" || r.kind === "null";
        const base = (t: SubsetType): SubsetType => (t.kind === "nullable" ? t.inner : t);
        if (!againstNull && (isReference(base(l)) || isReference(base(r))))
          fail(
            `${e.op} on records compares references in JavaScript; compare their fields instead`,
          );
        if (!comparable(l, r)) fail(`${e.op} between a ${describe(l)} and a ${describe(r)}`);
      }
      return ["+", "-", "*", "/"].includes(e.op) ? { kind: "int" } : { kind: "bool" };
    }
    case "neg": {
      const t = typeOf(e.operand, scope, ctx, fail);
      if (t.kind !== "int") fail(`unary minus on a ${t.kind}`);
      return { kind: "int" };
    }
    case "not": {
      const t = typeOf(e.operand, scope, ctx, fail);
      if (t.kind !== "bool") fail(`! on a ${t.kind}`);
      return { kind: "bool" };
    }
    case "isInteger": {
      const t = typeOf(e.operand, scope, ctx, fail);
      if (t.kind !== "int") fail(`Number.isInteger on a ${t.kind}`);
      return { kind: "bool" };
    }
    case "floor": {
      const t = typeOf(e.operand, scope, ctx, fail);
      if (t.kind !== "int") fail(`Math.floor on a ${t.kind}`);
      return { kind: "int" };
    }
    case "cond": {
      const test = typeOf(e.test, scope, ctx, fail);
      if (test.kind !== "bool")
        fail(
          `a condition that is a ${describe(test)} (truthiness is not in the subset; compare it)`,
        );
      const a = typeOf(e.ifTrue, scope, ctx, fail, expected);
      const b = typeOf(e.ifFalse, scope, ctx, fail, expected);
      const joined = join(a, b, ctx);
      if (joined) return joined;
      if (expected && fits(a, expected, ctx) && fits(b, expected, ctx)) return expected;
      return fail(
        `the branches of a conditional have different types (${describe(a)} and ${describe(b)})`,
      );
    }
    case "let": {
      const inferred = typeOf(e.value, scope, ctx, fail, e.type);
      if (e.type && !fits(inferred, e.type, ctx))
        fail(`const ${e.name} is annotated ${describe(e.type)} but holds a ${describe(inferred)}`);
      if (!e.type && holdsNothing(inferred))
        fail(
          `const ${e.name} holds an empty array of no declared type (annotate it: const ${e.name}: T[] = [])`,
        );
      return typeOf(e.body, new Map([...scope, [e.name, e.type ?? inferred]]), ctx, fail, expected);
    }
    case "call": {
      const sig = ctx.signatures.get(e.callee);
      if (!sig) fail(`the signature of ${e.callee} is not known`);
      if (sig.params.length !== e.args.length)
        fail(`${e.callee} takes ${sig.params.length} argument(s), called with ${e.args.length}`);
      e.args.forEach((a, i) => {
        const want = sig.params[i]?.type as SubsetType;
        const got = typeOf(a, scope, ctx, fail, want);
        if (!fits(got, want, ctx))
          fail(
            `argument ${i + 1} of ${e.callee} is a ${describe(got)}, not the ${describe(want)} it takes`,
          );
      });
      return sig.returns;
    }
    case "field": {
      const o = typeOf(e.object, scope, ctx, fail);
      if (o.kind === "list") {
        if (e.field !== "length") fail(`${e.field} read from a list (the subset has length)`);
        elementOf(o, "length", fail);
        return { kind: "int" };
      }
      if (o.kind === "nullable")
        fail(
          `field ${e.field} read from a ${describe(o)}: compare it with null first, which narrows it`,
        );
      if (o.kind === "union") {
        // Only a field every member has, with one type: the tag, typically. Narrowing by the tag is not in the subset yet.
        const members = membersIn(o.name, ctx);
        const types = members.map((rec) => rec.fields.find((x) => x.name === e.field)?.type);
        if (types.some((t) => t === undefined))
          fail(
            `field ${e.field} is not on every member of ${o.name} (test the tag first, which narrows it)`,
          );
        const first = types[0] as SubsetType;
        if (!types.every((t) => sameType(t as SubsetType, first)))
          fail(`field ${e.field} has different types across the members of ${o.name}`);
        return first;
      }
      if (o.kind !== "record") fail(`field ${e.field} read from a ${describe(o)}`);
      const f = ctx.records.get(o.name)?.fields.find((x) => x.name === e.field);
      if (!f) fail(`${o.name} has no field ${e.field}`);
      return f.type;
    }
    case "record": {
      // The record types whose fields are exactly these names, then those whose field types the values fit.
      const names = e.fields
        .map((f) => f.name)
        .sort()
        .join(",");
      // The context's type, when the compiler gave one, narrows the candidates: the record itself, or a union's members.
      const context = e.type;
      const candidates =
        context?.kind === "record"
          ? [...ctx.records.values()].filter((rec) => rec.name === context.name)
          : context?.kind === "union"
            ? membersIn(context.name, ctx)
            : [...ctx.records.values()];
      const byNames = candidates.filter(
        (rec) =>
          rec.fields
            .map((f) => f.name)
            .sort()
            .join(",") === names,
      );
      if (byNames.length === 0)
        fail(`a record literal with fields ${names} matches no declared record type`);
      const types = new Map(e.fields.map((f) => [f.name, typeOf(f.value, scope, ctx, fail)]));
      const fitting = byNames.filter((rec) =>
        rec.fields.every((f) => fits(types.get(f.name) as SubsetType, f.type, ctx)),
      );
      if (fitting.length === 0) {
        const rec = byNames[0] as RecordType;
        const off = rec.fields.find(
          (f) => !fits(types.get(f.name) as SubsetType, f.type, ctx),
        ) as Field;
        fail(
          `field ${off.name} of a ${rec.name} literal holds a ${describe(types.get(off.name) as SubsetType)}, not a ${describe(off.type)}`,
        );
      }
      // Among a union's members, the literal's tag tells them apart.
      const literalOf = (name: string): string | boolean | undefined => {
        const v = e.fields.find((f) => f.name === name)?.value;
        return v?.kind === "string" || v?.kind === "bool" ? v.value : undefined;
      };
      const tagged = fitting.filter((rec) =>
        rec.fields.every((f) => f.literal === undefined || literalOf(f.name) === f.literal),
      );
      const chosen = tagged.length > 0 ? tagged : fitting;
      if (chosen.length > 1)
        fail(
          `a record literal with fields ${names} matches ${chosen.map((r) => r.name).join(" and ")} alike`,
        );
      return { kind: "record", name: (chosen[0] as RecordType).name };
    }
    case "list": {
      let element: SubsetType = { kind: "nothing" };
      const add = (t: SubsetType) => {
        const joined = join(element, t, ctx);
        if (!joined) fail(`an array literal of a ${describe(element)} and a ${describe(t)}`);
        element = joined;
      };
      for (const item of e.items) add(typeOf(item, scope, ctx, fail));
      if (e.rest) add(elementOf(typeOf(e.rest, scope, ctx, fail), "a spread", fail));
      return { kind: "list", element };
    }
    case "tail": {
      const t = typeOf(e.list, scope, ctx, fail);
      elementOf(t, "slice", fail);
      return t;
    }
    case "headOr": {
      const element = elementOf(typeOf(e.list, scope, ctx, fail), "[0]", fail);
      // `??` replaces null as well as the missing head: on a list of a nullable type it is not headD.
      if (element.kind === "nullable" || element.kind === "null")
        fail("xs[0] ?? on a list of a nullable type (?? replaces a null element too)");
      const fallback = typeOf(e.fallback, scope, ctx, fail);
      const joined = join(element, fallback, ctx);
      if (!joined) fail(`?? between a ${describe(element)} and a ${describe(fallback)}`);
      return joined;
    }
    case "iterate": {
      const body = typeOf(e.body, iterateScope(e, e.list, scope, ctx, fail), ctx, fail);
      if (e.op === "map") return { kind: "list", element: body };
      if (e.op === "flatMap")
        return { kind: "list", element: elementOf(body, "flatMap's callback result", fail) };
      if (body.kind !== "bool")
        fail(`${e.op}'s callback returns a ${describe(body)}, not a boolean`);
      return { kind: "bool" };
    }
    case "fold":
      return foldScope(e, e.list, e.init, scope, ctx, fail).acc;
  }
}
