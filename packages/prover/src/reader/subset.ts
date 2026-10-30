/**
 * The pure TypeScript subset the first-party engines accept, read into a
 * small tree: exported functions (declarations, and arrows a module-level
 * `const` holds) over `number`, `boolean` and `string`,
 * record types, nullable types (`T | null`) and tagged unions of records,
 * lists of any of those, returning any of those; bodies made of `const`
 * bindings, `if` with early returns, `return`, and expressions from
 * arithmetic (`+ - *`), comparisons, `=== !==` (`null` included, which
 * narrows a nullable name in the branch it guards), `&& || !`, the
 * conditional operator, record and array literals, field reads (on a
 * union, only a field every member has), list methods and calls to the
 * module's own functions. Types are whatever the compiler resolves them
 * to: declared anywhere in the file, imported from another file, or an
 * instantiated generic. Anything else is `OutsideSubset`, with the
 * construct named: the subset is specified by the contract corpus and
 * widens one characterised class at a time. What each engine takes of it
 * is the engine's business (`restrictModule`). This module holds the
 * subset's meaning: its types and tree, typing, narrowing, renaming and
 * the three passes over a module; `expressions.ts` reads the syntax and
 * `types.ts` the compiler's types.
 */

import type { Arrow } from "@eutaxy/spec";
import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  InternalSymbolName,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import { type Checker, SymbolFlags, type Type } from "typescript/sync";
import {
  type InputFile,
  isAsync,
  isConst,
  lineAt,
  openParen,
  textOf,
  withProgram,
  withSourceFile,
} from "./compiler.ts";
import {
  blockOf,
  ExprReader,
  type Inline,
  type Names,
  syntacticType,
  type TypeSource,
} from "./expressions.ts";
import { SubsetTypes } from "./types.ts";

export class OutsideSubset extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

export type SubsetType =
  | { readonly kind: "int" }
  | { readonly kind: "bool" }
  | { readonly kind: "string" }
  | { readonly kind: "record"; readonly name: string }
  /** `T | null`. */
  | { readonly kind: "nullable"; readonly inner: SubsetType }
  /** A tagged union of records declared as a type alias; its members are records of the module. */
  | { readonly kind: "union"; readonly name: string }
  /** The type of the literal `null` itself, which only a nullable type accepts. */
  | { readonly kind: "null" }
  /** `readonly T[]` or `T[]`: a list of values of one type (Lean's `List`). */
  | { readonly kind: "list"; readonly element: SubsetType }
  /** The element type of `[]`, which fits in a list of any type. */
  | { readonly kind: "nothing" };

export interface Field {
  readonly name: string;
  readonly type: SubsetType;
  /** The one value a literal-typed field holds (`ok: true`, `type: "locked"`): a union member's tag. */
  readonly literal?: string | boolean;
}

export interface RecordType {
  readonly name: string;
  readonly fields: readonly Field[];
  /**
   * The tagged unions this record is a member of, in the order they were
   * read: `Err<E>` is one in `Result<A, E>` and in `Result<B, E>`. A member
   * written inline in a union is named `<union>.<tag>` after the first.
   */
  readonly unions?: readonly string[];
}

/** Whether a record is a member of a union. */
export function isMember(record: RecordType | undefined, union: string): boolean {
  return record?.unions?.includes(union) ?? false;
}

/** A union's members among the records known, in the order they were read. */
function membersIn(union: string, ctx: TypeContext): RecordType[] {
  return [...ctx.records.values()].filter((rec) => isMember(rec, union));
}

/** A tagged union: records told apart by one field, the tag, which holds a different literal in each. */
export interface UnionType {
  readonly name: string;
  readonly tag: string;
  /** The member records, in declaration order, by their tag's value. */
  readonly members: readonly { readonly tag: string | boolean; readonly record: string }[];
}

export type BinaryOp = "+" | "-" | "*" | "<" | "<=" | ">" | ">=" | "===" | "!==" | "&&" | "||";

export type Expr =
  | { readonly kind: "int"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "null" }
  | { readonly kind: "var"; readonly name: string }
  /** In `body`, `name` (a nullable in scope) stands for its non-null value: inserted where a null check guards. */
  | { readonly kind: "narrow"; readonly name: string; readonly body: Expr }
  /** In `body`, `name` (a union in scope) is its member `member`: inserted where a test of the union's tag guards. */
  | {
      readonly kind: "narrowTag";
      readonly name: string;
      readonly member: string;
      readonly body: Expr;
    }
  | { readonly kind: "neg"; readonly operand: Expr }
  | { readonly kind: "not"; readonly operand: Expr }
  /** `Number.isInteger(e)`: always true of an integer in the engines' integer model, the real predicate on doubles. */
  | { readonly kind: "isInteger"; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "cond"; readonly test: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr }
  | { readonly kind: "call"; readonly callee: string; readonly args: readonly Expr[] }
  | { readonly kind: "field"; readonly object: Expr; readonly field: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: string; readonly value: Expr }[];
      /** The type its context gives the literal (a declared return type, a const annotation, a parameter), as the compiler sees it: a record, or the union a member is picked from. */
      readonly type?: SubsetType;
    }
  | {
      readonly kind: "let";
      readonly name: string;
      readonly value: Expr;
      readonly body: Expr;
      /** The `const`'s annotation, when it has one: the binding's type, whatever the initializer's. */
      readonly type?: SubsetType;
    }
  /** `[a, b]`, or `[a, b, ...rest]` with the spread last. `xs.length` is a `field` read on a list. */
  | { readonly kind: "list"; readonly items: readonly Expr[]; readonly rest?: Expr }
  /** `xs.slice(1)`: every element but the first. */
  | { readonly kind: "tail"; readonly list: Expr }
  /** `xs[0] ?? fallback`: the first element, or the fallback for an empty list. */
  | { readonly kind: "headOr"; readonly list: Expr; readonly fallback: Expr }
  /** `xs.map`, `xs.flatMap`, `xs.every` or `xs.some` with `(item, index?) => body`. */
  | {
      readonly kind: "iterate";
      readonly op: "map" | "flatMap" | "every" | "some";
      readonly list: Expr;
      readonly item: string;
      readonly index?: string;
      readonly body: Expr;
    }
  /** `xs.reduce((acc, item) => body, init)`: a left fold. */
  | {
      readonly kind: "fold";
      readonly list: Expr;
      readonly acc: string;
      readonly item: string;
      readonly body: Expr;
      readonly init: Expr;
    };

export interface Param {
  readonly name: string;
  readonly type: SubsetType;
}

export interface SubsetFunction {
  readonly name: string;
  readonly params: readonly Param[];
  readonly returns: SubsetType;
  readonly body: Expr;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** Offset of the `(` opening its parameters: the declaration's identity, as the spec extractor records it. */
  readonly offset: number;
  /**
   * For a recursive function, the list parameter it recurses on (its
   * index): the body tests that list's length against 0 first, and every
   * call to itself, in the other branch, passes that list's slice(1).
   */
  readonly structural?: number;
}

/** A function the subset does not take, and why. */
export interface OutsideFunction {
  readonly name: string;
  readonly line: number;
  readonly message: string;
}

export interface SubsetModule {
  readonly records: readonly RecordType[];
  readonly unions: readonly UnionType[];
  /** The functions in the subset, in source order, callees before callers. */
  readonly functions: readonly SubsetFunction[];
  /** The module's other functions: outside the subset themselves, or calling one that is. */
  readonly outside: readonly OutsideFunction[];
}

/** Whether a string holds a surrogate code unit without its pair: no Lean character corresponds to it. */
export function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** A type, for messages. */
export function describe(t: SubsetType): string {
  switch (t.kind) {
    case "record":
    case "union":
      return t.name;
    case "nullable":
      return `${describe(t.inner)} | null`;
    case "list":
      return t.element.kind === "nullable"
        ? `(${describe(t.element)})[]`
        : `${describe(t.element)}[]`;
    default:
      return t.kind;
  }
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
 * The names a test, holding or failing, shows to be non-null: `x !== null`
 * holding, `x === null` failing, through `!`, `&&` (holding) and `||`
 * (failing).
 */
export function narrowsOf(test: Expr, holds: boolean): string[] {
  // A narrowing already inserted around an operand (the right side of `&&`) hides nothing.
  if (test.kind === "narrow" || test.kind === "narrowTag") return narrowsOf(test.body, holds);
  const isNull = (e: Expr) => e.kind === "null";
  if (test.kind === "binary" && (test.op === "===" || test.op === "!==")) {
    const other = isNull(test.right) ? test.left : isNull(test.left) ? test.right : undefined;
    if (other?.kind !== "var") return [];
    return (test.op === "!==") === holds ? [other.name] : [];
  }
  if (test.kind === "not") return narrowsOf(test.operand, !holds);
  if (test.kind === "binary" && test.op === "&&" && holds)
    return [...narrowsOf(test.left, true), ...narrowsOf(test.right, true)];
  if (test.kind === "binary" && test.op === "||" && !holds)
    return [...narrowsOf(test.left, false), ...narrowsOf(test.right, false)];
  return [];
}

/** The field that tells a union's members apart: literal-typed in every member, with a different literal in each. */
function tagOf(union: string, ctx: TypeContext): string | undefined {
  const members = membersIn(union, ctx);
  const first = members[0];
  if (!first) return undefined;
  return first.fields
    .filter((f) => f.literal !== undefined)
    .map((f) => f.name)
    .find((name) => {
      const values = members.map((m) => m.fields.find((f) => f.name === name)?.literal);
      return (
        values.every((v) => v !== undefined) &&
        new Set(values.map((v) => JSON.stringify(v))).size === values.length
      );
    });
}

/**
 * The names a test, holding or failing, shows to be one member of their
 * union, with that member: `x.tag === "a"` holding (or `!==` failing)
 * names the member tagged `"a"`; failing, the other member when the
 * union has two; `x.ok` alone is the test of a boolean tag; through `!`,
 * `&&` (holding) and `||` (failing) as null checks are.
 */
export function tagNarrowsOf(
  test: Expr,
  holds: boolean,
  scope: ReadonlyMap<string, SubsetType>,
  ctx: TypeContext,
): { name: string; member: string }[] {
  // The union a `x.tag` read is the tag of, with its members by tag value.
  const tagged = (e: Expr): { name: string; members: readonly RecordType[] } | undefined => {
    if (e.kind !== "field" || e.object.kind !== "var") return undefined;
    const t = scope.get(e.object.name);
    if (t?.kind !== "union" || tagOf(t.name, ctx) !== e.field) return undefined;
    return {
      name: e.object.name,
      members: membersIn(t.name, ctx),
    };
  };
  const byTag = (
    read: { name: string; members: readonly RecordType[] },
    tag: string,
    value: string | boolean,
    isIt: boolean,
  ): { name: string; member: string }[] => {
    const same = read.members.filter(
      (m) => m.fields.find((f) => f.name === tag)?.literal === value,
    );
    const chosen = isIt ? same : read.members.filter((m) => !same.includes(m));
    return chosen.length === 1 ? [{ name: read.name, member: (chosen[0] as RecordType).name }] : [];
  };
  if (test.kind === "narrow" || test.kind === "narrowTag")
    return tagNarrowsOf(test.body, holds, scope, ctx);
  if (test.kind === "binary" && (test.op === "===" || test.op === "!==")) {
    const literal = (e: Expr) => (e.kind === "string" || e.kind === "bool" ? e.value : undefined);
    const [field, value] =
      literal(test.right) !== undefined
        ? [test.left, literal(test.right)]
        : [test.right, literal(test.left)];
    if (value === undefined || field.kind !== "field") return [];
    const read = tagged(field);
    if (!read) return [];
    return byTag(read, field.field, value, (test.op === "===") === holds);
  }
  if (test.kind === "field") {
    const read = tagged(test);
    return read ? byTag(read, test.field, holds, true) : [];
  }
  if (test.kind === "not") return tagNarrowsOf(test.operand, !holds, scope, ctx);
  if (test.kind === "binary" && test.op === "&&" && holds)
    return [
      ...tagNarrowsOf(test.left, true, scope, ctx),
      ...tagNarrowsOf(test.right, true, scope, ctx),
    ];
  if (test.kind === "binary" && test.op === "||" && !holds)
    return [
      ...tagNarrowsOf(test.left, false, scope, ctx),
      ...tagNarrowsOf(test.right, false, scope, ctx),
    ];
  return [];
}

/**
 * `narrow` and `narrowTag` nodes inserted where a test guards: in a
 * conditional's branches, and in the right operand of `&&` and `||`, for
 * each nullable name the test shows to be non-null there and each union
 * name it shows to be one member there.
 */
export function insertNarrows(
  e: Expr,
  scope: ReadonlyMap<string, SubsetType>,
  ctx: TypeContext,
  fail: (message: string) => never,
): Expr {
  const go = (x: Expr, sc: ReadonlyMap<string, SubsetType>): Expr =>
    insertNarrows(x, sc, ctx, fail);
  const wrap = (
    body: Expr,
    test: Expr,
    holds: boolean,
    sc: ReadonlyMap<string, SubsetType>,
  ): Expr => {
    const inner = new Map(sc);
    let out = body;
    const nullable = [...new Set(narrowsOf(test, holds))].filter(
      (n) => sc.get(n)?.kind === "nullable",
    );
    for (const n of nullable) inner.set(n, (sc.get(n) as { inner: SubsetType }).inner);
    // Tag tests are read in the scope null checks leave: `x !== null && x.ok` narrows x twice.
    const tags: { name: string; member: string }[] = [];
    for (const t of tagNarrowsOf(test, holds, inner, ctx))
      if (!tags.some((x) => x.name === t.name)) {
        tags.push(t);
        inner.set(t.name, { kind: "record", name: t.member });
      }
    out = go(out, inner);
    for (const t of tags.reverse())
      out = { kind: "narrowTag", name: t.name, member: t.member, body: out };
    for (const n of nullable.reverse()) out = { kind: "narrow", name: n, body: out };
    return out;
  };
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return e;
    case "neg":
    case "not":
    case "isInteger":
      return { kind: e.kind, operand: go(e.operand, scope) };
    case "narrow":
    case "narrowTag":
      return e;
    case "binary": {
      const left = go(e.left, scope);
      if (e.op === "&&")
        return { kind: "binary", op: e.op, left, right: wrap(e.right, left, true, scope) };
      if (e.op === "||")
        return { kind: "binary", op: e.op, left, right: wrap(e.right, left, false, scope) };
      return { kind: "binary", op: e.op, left, right: go(e.right, scope) };
    }
    case "cond": {
      const test = go(e.test, scope);
      return {
        kind: "cond",
        test,
        ifTrue: wrap(e.ifTrue, test, true, scope),
        ifFalse: wrap(e.ifFalse, test, false, scope),
      };
    }
    case "call":
      return { kind: "call", callee: e.callee, args: e.args.map((a) => go(a, scope)) };
    case "field":
      return { kind: "field", object: go(e.object, scope), field: e.field };
    case "record":
      return { ...e, fields: e.fields.map((f) => ({ name: f.name, value: go(f.value, scope) })) };
    case "let": {
      const value = go(e.value, scope);
      const inner = new Map(scope);
      inner.set(e.name, e.type ?? typeOf(value, scope, ctx, fail));
      return { ...e, value, body: go(e.body, inner) };
    }
    case "list":
      return {
        kind: "list",
        items: e.items.map((x) => go(x, scope)),
        ...(e.rest ? { rest: go(e.rest, scope) } : {}),
      };
    case "tail":
      return { kind: "tail", list: go(e.list, scope) };
    case "headOr":
      return { kind: "headOr", list: go(e.list, scope), fallback: go(e.fallback, scope) };
    case "iterate": {
      const list = go(e.list, scope);
      return { ...e, list, body: go(e.body, iterateScope(e, list, scope, ctx, fail)) };
    }
    case "fold": {
      const list = go(e.list, scope);
      const init = go(e.init, scope);
      // The callback's names before its body is typed: its null checks narrow first, as in map.
      const inner = new Map(scope);
      inner.set(e.acc, typeOf(init, scope, ctx, fail));
      inner.set(e.item, elementOf(typeOf(list, scope, ctx, fail), "reduce", fail));
      return { ...e, list, init, body: go(e.body, inner) };
    }
  }
}

/**
 * The element type of a list expression's type. An operation on an empty
 * array no type is given for (`[].length`, `[].slice(1)`) is refused: an
 * engine could only guess the element type, and such code has a plain
 * value to write instead; `const xs: T[] = []` gives one.
 */
function elementOf(t: SubsetType, what: string, fail: (message: string) => never): SubsetType {
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
function iterateScope(
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
      const arithmetic = ["+", "-", "*", "<", "<=", ">", ">="].includes(e.op);
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
      return ["+", "-", "*"].includes(e.op) ? { kind: "int" } : { kind: "bool" };
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

/** Every name an expression binds or refers to: its variables and its lets. */
function boundNames(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
      return out;
    case "var":
      out.add(e.name);
      return out;
    case "narrow":
    case "narrowTag":
      out.add(e.name);
      return boundNames(e.body, out);
    case "neg":
    case "not":
    case "isInteger":
      return boundNames(e.operand, out);
    case "binary":
      boundNames(e.left, out);
      return boundNames(e.right, out);
    case "cond":
      boundNames(e.test, out);
      boundNames(e.ifTrue, out);
      return boundNames(e.ifFalse, out);
    case "call":
      for (const a of e.args) boundNames(a, out);
      return out;
    case "field":
      return boundNames(e.object, out);
    case "record":
      for (const f of e.fields) boundNames(f.value, out);
      return out;
    case "let":
      out.add(e.name);
      boundNames(e.value, out);
      return boundNames(e.body, out);
    case "list":
      for (const x of e.items) boundNames(x, out);
      return e.rest ? boundNames(e.rest, out) : out;
    case "tail":
      return boundNames(e.list, out);
    case "headOr":
      boundNames(e.list, out);
      return boundNames(e.fallback, out);
    case "iterate":
      out.add(e.item);
      if (e.index !== undefined) out.add(e.index);
      boundNames(e.list, out);
      return boundNames(e.body, out);
    case "fold":
      out.add(e.acc);
      out.add(e.item);
      boundNames(e.list, out);
      boundNames(e.init, out);
      return boundNames(e.body, out);
  }
}

/** A name not among `taken`: the name with underscores appended. */
function fresh(name: string, taken: ReadonlySet<string>): string {
  let out = `${name}_`;
  while (taken.has(out)) out += "_";
  return out;
}

/**
 * The expression with its variables renamed (an arrow's own parameter
 * names to the binders'). A `let` whose name is a rename's target would
 * capture the renamed references in its body, so such a let is renamed to
 * a fresh name first; a let whose name is a rename's source shadows it.
 */
export function renameVars(
  e: Expr,
  names: ReadonlyMap<string, string>,
  taken: ReadonlySet<string> = new Set([...names.keys(), ...names.values(), ...boundNames(e)]),
  /** Names no binder in `e` may keep (the scope `e` is inlined into): such a binder moves to a fresh name. */
  avoid: ReadonlySet<string> = new Set(),
): Expr {
  const go = (x: Expr): Expr => renameVars(x, names, taken, avoid);
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
      return e;
    case "var":
      return { kind: "var", name: names.get(e.name) ?? e.name };
    case "narrow":
      return { kind: "narrow", name: names.get(e.name) ?? e.name, body: go(e.body) };
    case "narrowTag":
      return { ...e, name: names.get(e.name) ?? e.name, body: go(e.body) };
    case "neg":
    case "not":
    case "isInteger":
      return { kind: e.kind, operand: go(e.operand) };
    case "binary":
      return { kind: "binary", op: e.op, left: go(e.left), right: go(e.right) };
    case "cond":
      return { kind: "cond", test: go(e.test), ifTrue: go(e.ifTrue), ifFalse: go(e.ifFalse) };
    case "call":
      return { kind: "call", callee: e.callee, args: e.args.map(go) };
    case "field":
      return { kind: "field", object: go(e.object), field: e.field };
    case "record":
      return { ...e, fields: e.fields.map((f) => ({ name: f.name, value: go(f.value) })) };
    case "let": {
      // A let binds its own name; a binder of that name is shadowed inside, as in the source.
      const inner = new Map(names);
      inner.delete(e.name);
      let bound = e.name;
      const targets = new Set([...names.values(), ...avoid]);
      if (targets.has(e.name)) {
        // The let would capture a renamed reference: the let itself moves out of the way, to a name
        // nothing in the expression uses (another let may already be spelled with the underscore).
        bound = fresh(e.name, taken);
        inner.set(e.name, bound);
      }
      return {
        ...e,
        name: bound,
        value: go(e.value),
        body: renameVars(e.body, inner, new Set([...taken, bound]), avoid),
      };
    }
    case "list":
      return { kind: "list", items: e.items.map(go), ...(e.rest ? { rest: go(e.rest) } : {}) };
    case "tail":
      return { kind: "tail", list: go(e.list) };
    case "headOr":
      return { kind: "headOr", list: go(e.list), fallback: go(e.fallback) };
    case "iterate": {
      const own = [e.item, ...(e.index === undefined ? [] : [e.index])];
      const { inner, bound, scoped } = bindAll(own, names, taken, avoid);
      return {
        ...e,
        list: go(e.list),
        item: bound[0] as string,
        ...(e.index === undefined ? {} : { index: bound[1] as string }),
        body: renameVars(e.body, inner, scoped, avoid),
      };
    }
    case "fold": {
      const { inner, bound, scoped } = bindAll([e.acc, e.item], names, taken, avoid);
      return {
        ...e,
        list: go(e.list),
        init: go(e.init),
        acc: bound[0] as string,
        item: bound[1] as string,
        body: renameVars(e.body, inner, scoped, avoid),
      };
    }
  }
}

/**
 * The renames inside a callback that binds `own` names, as for a let:
 * each shadows a rename of its own name, and one that is a rename's target
 * moves to a fresh name so it captures nothing.
 */
function bindAll(
  own: readonly string[],
  names: ReadonlyMap<string, string>,
  taken: ReadonlySet<string>,
  avoid: ReadonlySet<string>,
): { inner: Map<string, string>; bound: string[]; scoped: Set<string> } {
  const inner = new Map(names);
  const targets = new Set([...names.values(), ...avoid]);
  const scoped = new Set(taken);
  const bound = own.map((n) => {
    inner.delete(n);
    if (!targets.has(n)) return n;
    const moved = fresh(n, scoped);
    scoped.add(moved);
    inner.set(n, moved);
    return moved;
  });
  return { inner, bound, scoped };
}

/** The functions an expression calls. */
function callees(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return out;
    case "narrow":
    case "narrowTag":
      return callees(e.body, out);
    case "neg":
    case "not":
    case "isInteger":
      return callees(e.operand, out);
    case "binary":
      callees(e.left, out);
      return callees(e.right, out);
    case "cond":
      callees(e.test, out);
      callees(e.ifTrue, out);
      return callees(e.ifFalse, out);
    case "call":
      out.add(e.callee);
      for (const a of e.args) callees(a, out);
      return out;
    case "field":
      return callees(e.object, out);
    case "record":
      for (const f of e.fields) callees(f.value, out);
      return out;
    case "let":
      callees(e.value, out);
      return callees(e.body, out);
    case "list":
      for (const x of e.items) callees(x, out);
      return e.rest ? callees(e.rest, out) : out;
    case "tail":
      return callees(e.list, out);
    case "headOr":
      callees(e.list, out);
      return callees(e.fallback, out);
    case "iterate":
      callees(e.list, out);
      return callees(e.body, out);
    case "fold":
      callees(e.list, out);
      callees(e.init, out);
      return callees(e.body, out);
  }
}

// ---------------------------------------------------------------------------
// Reading: a module through the compiler, an arrow from its text.

/** The path a module read from text alone is compiled under: an import of another file does not resolve from it. */
const virtualModulePath = "/eutaxy/reader/module.ts";

export interface ReadSubsetOptions {
  /** The module's path on disk, under which its imports resolve. Without it the module stands alone. */
  readonly path?: string;
  /** Other files the read sees in place of (or beside) the files on disk, by path. */
  readonly files?: readonly InputFile[];
}

/** What typing a module's expressions needs, shared by every function read. */
function moduleContext(records: Map<string, RecordType>): {
  ctx: TypeContext;
  signatures: Map<string, CalleeSignature>;
} {
  const signatures = new Map<string, CalleeSignature>();
  return { ctx: { records, signatures }, signatures };
}

/** The contextual type the compiler gives a record literal, as the subset reads it; undefined where it has none the subset takes. */
function contextualType(
  checker: Checker,
  types: SubsetTypes,
  node: ObjectLiteralExpression,
): SubsetType | undefined {
  const type = checker.getContextualType(node);
  if (!type) return undefined;
  // A context inferred from the literal itself (a callback's result, say) declares nothing: the
  // literal is matched against the declared records instead.
  const fromLiteral = (t: Type): boolean =>
    t.isObjectType() && t.getSymbol()?.name === InternalSymbolName.Object;
  if (fromLiteral(type) || (type.isUnionType() && type.getTypes().some(fromLiteral)))
    return undefined;
  const skip = Symbol("outside");
  try {
    const read = types.of(type, () => {
      throw skip;
    });
    return read.kind === "nullable" ? read.inner : read;
  } catch (err) {
    if (err === skip) return undefined;
    throw err;
  }
}

/** The line of the first direct `eval` in the file: a mention that is not a property of something else. */
function directEval(sf: SourceFile): number | undefined {
  let line: number | undefined;
  const visit = (node: Node): void => {
    if (line !== undefined) return;
    if (is.isIdentifier(node) && node.text === "eval") {
      const parent = node.parent;
      const property =
        (is.isPropertyAccessExpression(parent) && parent.name === node) ||
        (is.isPropertyAssignment(parent) && parent.name === node);
      if (!property) {
        line = lineAt(sf, node);
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return line;
}

/** Whether an identifier is written to: assigned, updated, or bound by a destructuring or a `for` head. */
function isWritten(node: Node): boolean {
  let n: Node = node;
  for (;;) {
    const p: Node = n.parent;
    if (!p) return false;
    // The outer expressions TypeScript lets wrap an assignment target: parentheses and assertions.
    if (
      (is.isParenthesizedExpression(p) ||
        is.isNonNullExpression(p) ||
        is.isAsExpression(p) ||
        is.isSatisfiesExpression(p) ||
        is.isTypeAssertion(p)) &&
      p.expression === n
    ) {
      n = p;
      continue;
    }
    if (is.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (p.left === n && k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment)
        return true;
      return false;
    }
    if (is.isPrefixUnaryExpression(p) || is.isPostfixUnaryExpression(p))
      return p.operator === SyntaxKind.PlusPlusToken || p.operator === SyntaxKind.MinusMinusToken;
    if (is.isForInStatement(p) || is.isForOfStatement(p)) return p.initializer === n;
    // Inside a destructuring target, the whole pattern is what gets assigned.
    if (is.isArrayLiteralExpression(p) || is.isSpreadElement(p) || is.isSpreadAssignment(p)) {
      n = p;
      continue;
    }
    if (is.isPropertyAssignment(p) && p.initializer === n) {
      n = p.parent;
      continue;
    }
    if (is.isShorthandPropertyAssignment(p) && p.name === n) {
      n = p.parent;
      continue;
    }
    if (is.isObjectLiteralExpression(p)) {
      n = p;
      continue;
    }
    return false;
  }
}

/**
 * The declared functions the module assigns to anywhere, with the line
 * of the first assignment: what runs under such a name may not be its
 * declaration. A name is confirmed through the compiler, so a local of
 * the same name assigned in some block is not the function.
 */
function assigned(
  sf: SourceFile,
  checker: Checker,
  declarations: ReadonlyMap<string, Declared>,
): Map<string, number> {
  const out = new Map<string, number>();
  const symbolIds = new Map<string, number | undefined>();
  const idOf = (name: string): number | undefined => {
    if (!symbolIds.has(name)) {
      const decl = declarations.get(name);
      symbolIds.set(name, decl ? checker.getSymbolAtLocation(decl.name)?.id : undefined);
    }
    return symbolIds.get(name);
  };
  const visit = (node: Node): void => {
    if (
      is.isIdentifier(node) &&
      declarations.has(node.text) &&
      !out.has(node.text) &&
      isWritten(node)
    ) {
      const id = idOf(node.text);
      // In `({ f } = …)` the name is the property's; the value it assigns is the binding's symbol.
      const parent = node.parent;
      const symbol =
        is.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
      if (id !== undefined && symbol?.id === id) out.set(node.text, lineAt(sf, node));
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** A function as written: a declaration, or the arrow (or function expression) a module-level binding holds. */
type FunctionNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

/** A module-level function: its name, its node, and the statement declaring it (for its line). */
interface Declared {
  readonly name: Identifier;
  readonly node: FunctionNode;
  readonly statement: Node;
}

/** A function's header read: its typed parameters and return type, with the body still to read. */
interface Head {
  readonly name: string;
  readonly decl: FunctionNode;
  readonly params: readonly Param[];
  readonly returns: SubsetType;
  readonly line: number;
  readonly offset: number;
}

/** The parameter names of a function the subset can take at all: synchronous, no generator, plain parameters. */
function shape(reader: ExprReader, decl: FunctionNode): string[] {
  if (isAsync(decl)) reader.fail("an async function (core functions are synchronous)", decl);
  if (!is.isArrowFunction(decl) && decl.asteriskToken) reader.fail("a generator function", decl);
  return decl.parameters.map((p) => {
    if (!is.isIdentifier(p.name)) reader.fail("a destructured parameter", p);
    const pname = p.name.text;
    if (p.dotDotDotToken) reader.fail("a rest parameter", p);
    // `this: T` annotates the receiver and is erased; it is no argument the function is called with.
    if (pname === "this") reader.fail("a this parameter (the receiver is not modelled)", p);
    if (p.questionToken) reader.fail(`optional parameter ${pname}`, p);
    if (p.initializer) reader.fail(`a default value for ${pname}`, p);
    return pname;
  });
}

/** `export function name(params): Type {` or `export const name = (params): Type => …` read, the types through the compiler. */
function head(reader: ExprReader, types: SubsetTypes, checker: Checker, d: Declared): Head {
  const sf = reader.sf;
  const decl = d.node;
  const name = d.name.text;
  const pnames = shape(reader, decl);
  if (decl.typeParameters) reader.fail("type parameters", decl.typeParameters[0] ?? decl);
  const params: Param[] = decl.parameters.map((p, i) => {
    const pname = pnames[i] as string;
    if (!p.type) reader.fail(`parameter ${pname} without a type`, p);
    return {
      name: pname,
      type: types.of(checker.getTypeAtLocation(p.type), reader.refuseAt(p.type)),
    };
  });
  if (!decl.type)
    reader.fail(
      `${name} without a return type (the subset needs it to name the record returned)`,
      decl,
    );
  const returns = types.of(checker.getTypeAtLocation(decl.type), reader.refuseAt(decl.type));
  if (!decl.body) reader.fail("a function without a body", decl);
  const offset = openParen(sf, decl);
  if (offset === undefined) reader.fail("a function without a parameter list", decl);
  return { name, decl, params, returns, line: lineAt(sf, d.statement), offset };
}

/** The function, its body read and typed against its header. */
function declaration(reader: ExprReader, h: Head): SubsetFunction {
  const body = h.decl.body as NonNullable<FunctionNode["body"]>;
  const scope = new Map(h.params.map((p) => [p.name, p.type]));
  // An arrow's expression body is its one return. Null checks narrow the names they guard in the
  // branches they guard, before anything is typed.
  const statements = is.isBlock(body)
    ? reader.block(body.statements, scope, body)
    : reader.expression(body, scope);
  const read = reader.narrowed(statements, scope, body);
  // Typing the whole body here: a record literal of no declared type, a field read on an integer or
  // a body of another type than declared are all outside the subset, found now rather than by an engine.
  const actual = reader.typeOfExpr(read, scope, body, h.returns);
  if (!fits(actual, h.returns, reader.ctx))
    reader.fail(
      `${h.name} returns a ${describe(actual)} but declares ${describe(h.returns)}`,
      body,
    );
  return {
    name: h.name,
    params: h.params,
    returns: h.returns,
    body: read,
    line: h.line,
    offset: h.offset,
  };
}

/** A file's top-level functions, and the ones whose name may run something else, with why. */
interface FileFunctions {
  readonly declarations: ReadonlyMap<string, Declared>;
  readonly overloaded: ReadonlySet<string>;
  readonly untrusted: ReadonlyMap<string, OutsideFunction>;
}

/**
 * A file's top-level functions: declarations, and the arrows module-level
 * consts hold. A binding that may be reassigned (let, var) or holds a
 * function expression is listed, for its callers' typing, and untrusted;
 * so is every function of a file mentioning eval directly, and a function
 * the file assigns to.
 */
function fileFunctions(sf: SourceFile, checker: Checker): FileFunctions {
  const declarations = new Map<string, Declared>();
  const overloaded = new Set<string>();
  const untrusted = new Map<string, OutsideFunction>();
  const declare = (name: Identifier, node: FunctionNode, statement: Node): void => {
    if (declarations.has(name.text)) overloaded.add(name.text);
    else declarations.set(name.text, { name, node, statement });
  };
  for (const st of sf.statements) {
    if (is.isFunctionDeclaration(st)) {
      if (st.name) declare(st.name, st, st);
      continue;
    }
    if (!is.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!is.isIdentifier(d.name) || !d.initializer) continue;
      let init: Expression = d.initializer;
      while (is.isParenthesizedExpression(init)) init = init.expression;
      if (!is.isArrowFunction(init) && !is.isFunctionExpression(init)) continue;
      const name = d.name.text;
      declare(d.name, init, st);
      if (!isConst(st.declarationList))
        untrusted.set(name, {
          name,
          line: lineAt(sf, st),
          message: `${name} is declared with let or var, so what runs under its name may be another function`,
        });
      else if (is.isFunctionExpression(init))
        untrusted.set(name, {
          name,
          line: lineAt(sf, st),
          message: `${name} holds a function expression (write a function declaration or an arrow)`,
        });
    }
  }
  // A direct eval can rebind any declaration of the file without naming it, so any mention of `eval`
  // that is not a property of something else (`globalThis.eval` is indirect, and cannot) puts every
  // function outside: `eval(…)`, `(eval)(…)`, inside a template substitution alike.
  const evalLine = directEval(sf);
  if (evalLine !== undefined)
    for (const name of declarations.keys())
      untrusted.set(name, {
        name,
        line: evalLine,
        message: "the module mentions eval directly, which can rebind any of its declarations",
      });
  for (const [name, line] of assigned(sf, checker, declarations))
    if (!untrusted.has(name))
      untrusted.set(name, {
        name,
        line,
        message: `${name} is assigned in the module, so what runs under its name may not be its declaration`,
      });
  return { declarations, overloaded, untrusted };
}

/** What inlining a module's calls needs from the read it belongs to. */
interface InlinerContext {
  readonly checker: Checker;
  readonly types: SubsetTypes;
  readonly typeSource: TypeSource;
  readonly ctx: TypeContext;
  /** The module being read, and its functions. */
  readonly module: SourceFile;
  readonly own: FileFunctions;
  readonly parseError: (path: string) => { line: number; message: string } | undefined;
  readonly typeErrors: (path: string) => readonly { pos: number; end: number }[];
}

/**
 * Bind the type parameters in `declared` so that it is `expected`, or a
 * member of `expected` when that is a union: a parameter binds to what it
 * meets, and two instantiations of one alias match argument by argument.
 * Returns the type matched (the union member, say), or undefined, with
 * `bound` unchanged by a member that did not match.
 */
function match(declared: Type, expected: Type, bound: Map<number, Type>): Type | undefined {
  if (declared.isTypeParameter()) {
    const had = bound.get(declared.id);
    if (had && had.id !== expected.id) return undefined;
    bound.set(declared.id, expected);
    return expected;
  }
  const alias = declared.getAliasSymbol();
  const other = expected.getAliasSymbol();
  if (alias && other && alias.id === other.id) {
    const xs = declared.getAliasTypeArguments();
    const ys = expected.getAliasTypeArguments();
    if (xs.length !== ys.length) return undefined;
    const trial = new Map(bound);
    for (let i = 0; i < xs.length; i++)
      if (!match(xs[i] as Type, ys[i] as Type, trial)) return undefined;
    for (const [k, v] of trial) bound.set(k, v);
    return expected;
  }
  if (expected.isUnionType())
    for (const member of expected.getTypes()) {
      const trial = new Map(bound);
      if (match(declared, member, trial)) {
        for (const [k, v] of trial) bound.set(k, v);
        return member;
      }
    }
  return undefined;
}

/**
 * Calls to functions the module cannot name as its own, read inlined: a
 * generic function (of the module or not) at the call's instantiation,
 * and a function of another file, as the compiler resolves the import.
 * The callee's body is read in its own file under the parameter types the
 * call's resolved signature gives, its literals typed by the resolved
 * return type, its names moved away from the caller's, and bound by `let`
 * to the arguments in order: a pure function called by value computes
 * exactly that. The callee's own calls inline the same way, so the
 * helpers of its file come with it. A callee with no body here (a
 * declaration file), one its file may rebind, or one reached again while
 * it is being inlined (recursion) is outside the subset, with why.
 */
function inliner(c: InlinerContext): Inline {
  const files = new Map<SourceFile, FileFunctions>([[c.module, c.own]]);
  const functionsOf = (file: SourceFile): FileFunctions => {
    let found = files.get(file);
    if (!found) {
      found = fileFunctions(file, c.checker);
      files.set(file, found);
    }
    return found;
  };
  const inlining: string[] = [];
  // The type parameters of the functions being read, bound to the types their calls give them,
  // innermost last: a generic function read inside another sees the outer one's as concrete types.
  const substitutions: Map<number, Type>[] = [];
  const concrete = (t: Type): Type => {
    const top = substitutions[substitutions.length - 1];
    return top && t.isTypeParameter() ? (top.get(t.id) ?? t) : t;
  };
  // `fail` is annotated so that the compiler narrows after a call to it.
  const inline: Inline = (call, callee, scope, readArgs, fail: (what: string) => never) => {
    // A call the compiler rejects (a name imported with `import type`, which does not exist when the
    // code runs; arguments that do not fit) is no call the reader may stand in for.
    const caller = call.getSourceFile();
    const start = call.getStart(caller);
    if (c.typeErrors(caller.fileName).some((e) => e.pos < call.end && e.end > start))
      fail(`the compiler reports an error on this call to ${callee.text}`);
    let symbol = c.checker.getSymbolAtLocation(callee);
    if (!symbol) return undefined;
    if (symbol.flags & SymbolFlags.Alias) symbol = c.checker.getAliasedSymbol(symbol);
    const decl = symbol.valueDeclaration?.resolve();
    if (!decl || !(is.isFunctionDeclaration(decl) || is.isVariableDeclaration(decl)))
      return undefined;
    const file = decl.getSourceFile();
    // The declaration's own name: a default export's symbol is named `default`.
    const name = decl.name && is.isIdentifier(decl.name) ? decl.name.text : symbol.name;
    const where = file === c.module ? name : `${name} (from ${file.fileName})`;
    if (file.isDeclarationFile)
      fail(`${where} has no body to read: it is declared in a declaration file`);
    const fns = functionsOf(file);
    const d = fns.declarations.get(name);
    // Only a top-level function of its file is read; anything else is refused by the usual message.
    if (!d || !decl.name || d.name.pos !== decl.name.pos) return undefined;
    if (c.parseError(file.fileName)) fail(`${where} is in a file the compiler cannot parse`);
    const untrusted = fns.untrusted.get(name);
    if (untrusted) fail(`${where} is outside the subset: ${untrusted.message}`);
    if (fns.overloaded.has(name)) fail(`${where} is declared more than once (overloads)`);
    const body = d.node.body;
    if (!body) fail(`${where} has no body to read`);
    const signature = c.checker.getResolvedSignature(call);
    if (c.checker.isUnknownSignature(signature)) fail(`the call to ${where} does not resolve`);
    const fileNames: Names = {
      callable: () => false,
      target: (n) => n,
      declared: (n) => fns.declarations.has(n),
      spec: false,
    };
    const typeSource: TypeSource = {
      annotation: (node, refuse) => c.types.of(concrete(c.checker.getTypeAtLocation(node)), refuse),
      contextual: c.typeSource.contextual,
    };
    const reader = new ExprReader(file, fileNames, typeSource, c.ctx, undefined, inline);
    const params = shape(reader, d.node);
    const symbols = signature.getParameters();
    if (symbols.length !== params.length || call.arguments.length !== params.length)
      fail(`${where} takes ${params.length} argument(s), called with ${call.arguments.length}`);
    // A generic callee is instantiated by where its value goes first: the compiler infers `E` in
    // `err({ type: "locked" })` from the argument alone, a record of its own, where the caller's
    // declared result names the error union the literal belongs to. What the context leaves open
    // is the compiler's instantiation.
    const bound = new Map<number, Type>();
    const declared = c.checker.getSignatureFromDeclaration(d.node);
    const generalReturn = c.checker.getReturnTypeOfSignature(declared);
    const context = d.node.typeParameters ? c.checker.getContextualType(call) : undefined;
    const matched = context ? match(generalReturn, concrete(context), bound) : undefined;
    const declaredParams = declared.getParameters();
    const generalParams = symbols.map((_, i) => {
      const own = declaredParams[i];
      return own ? c.checker.getTypeOfSymbol(own) : undefined;
    });
    const resolvedParams = symbols.map((p) => concrete(c.checker.getTypeOfSymbol(p)));
    const resolvedReturn = concrete(c.checker.getReturnTypeOfSignature(signature));
    // The callee's own type parameters, for its body: the context's first, the compiler's after.
    generalParams.forEach((g, i) => {
      if (g) match(g, resolvedParams[i] as Type, bound);
    });
    match(generalReturn, resolvedReturn, bound);
    const types = symbols.map((_, i) => {
      const g = generalParams[i];
      const type =
        g?.isTypeParameter() && bound.has(g.id)
          ? concrete(bound.get(g.id) as Type)
          : (resolvedParams[i] as Type);
      return c.types.of(type, (what) =>
        fail(`${where}, parameter ${params[i]} at this call: ${what}`),
      );
    });
    const returns = c.types.of(matched ?? resolvedReturn, (what) =>
      fail(`${where} returns, at this call, ${what}`),
    );
    const own = new Map([...bound].map(([k, v]) => [k, concrete(v)]));
    // The arguments in the caller's scope, before this callee is marked as being read: a nested call
    // to the same function is no recursion.
    const args = readArgs(types);
    const key = `${file.fileName}#${name}`;
    if (inlining.includes(key))
      fail(
        `${where} is recursive, which a function read at its calls cannot be (recursion is in the subset only as a module's own structural recursion)`,
      );
    inlining.push(key);
    substitutions.push(own);
    try {
      const inner = new Map(params.map((p, i) => [p, types[i] as SubsetType]));
      const readBody = (): Expr => {
        const read = returning(
          is.isBlock(body)
            ? reader.block(body.statements, inner, body)
            : reader.expression(body, inner),
          returns,
        );
        const actual = reader.typeOfExpr(reader.narrowed(read, inner, body), inner, body, returns);
        if (!fits(actual, returns, c.ctx))
          reader.fail(
            `returns a ${describe(actual)}, not the ${describe(returns)} called for`,
            body,
          );
        return read;
      };
      let read: Expr;
      try {
        read = readBody();
      } catch (err) {
        if (!(err instanceof OutsideSubset)) throw err;
        fail(
          `${where}, read at this call, is outside the subset: ${err.message} (line ${err.line} of its file)`,
        );
      }
      // Its parameters and its own names move away from every name the caller has here.
      const callerNames = new Set([...scope.keys(), ...args.flatMap((a) => [...boundNames(a)])]);
      // Every parameter name is reserved, used or not, so no fresh name repeats one.
      const taken = new Set([...callerNames, ...boundNames(read), ...params]);
      const renames = new Map<string, string>();
      for (const p of params) {
        const to = callerNames.has(p) ? fresh(p, taken) : p;
        taken.add(to);
        renames.set(p, to);
      }
      const renamed = renameVars(read, renames, taken, callerNames);
      return params.reduceRight<Expr>(
        (rest, p, i) => ({
          kind: "let",
          name: renames.get(p) as string,
          value: args[i] as Expr,
          body: rest,
          type: types[i] as SubsetType,
        }),
        renamed,
      );
    } finally {
      substitutions.pop();
      inlining.pop();
    }
  };
  return inline;
}

/**
 * The expression with the record literals it returns typed `t`, where
 * they have no type of their own: a function inlined at a call returns
 * its instantiated type, which a literal in a generic body cannot name.
 */
function returning(e: Expr, t: SubsetType): Expr {
  const target = t.kind === "nullable" ? t.inner : t;
  if (target.kind !== "record" && target.kind !== "union") return e;
  switch (e.kind) {
    case "record":
      return e.type ? e : { ...e, type: target };
    case "let":
    case "narrow":
    case "narrowTag":
      return { ...e, body: returning(e.body, t) };
    case "cond":
      return { ...e, ifTrue: returning(e.ifTrue, t), ifFalse: returning(e.ifFalse, t) };
    default:
      return e;
  }
}

/**
 * Read a module: every function the subset takes (in source order, so
 * callees come before callers), the record types and unions they use,
 * and, for the other functions, why not. A function calling one outside
 * the subset is outside it too. The names given are what the caller
 * cares about; one the module does not declare at its top level is
 * reported among the others, not thrown.
 */
export function readSubset(
  source: string,
  functions?: readonly string[],
  options: ReadSubsetOptions = {},
): SubsetModule {
  const path = options.path ?? virtualModulePath;
  return withProgram(
    [{ path, text: source }, ...(options.files ?? [])],
    ({ checker, file, parseError, typeErrors }) => {
      const sf = file(path);
      // Pass 1: the module's top-level functions, and what makes them untrustworthy. A generic one is
      // no function of the subset (no claim is stated over a type parameter); its callers read it inlined.
      const own = fileFunctions(sf, checker);
      const { declarations, overloaded } = own;
      const declared = new Set(declarations.keys());
      const generic = new Set(
        [...declarations].filter(([, d]) => d.node.typeParameters).map(([name]) => name),
      );
      const outside = new Map<string, OutsideFunction>();
      const error = parseError(path);
      // Source the compiler cannot parse is source the reader cannot trust: every function is outside.
      if (error) {
        for (const name of new Set([...declared, ...(functions ?? [])]))
          outside.set(name, {
            name,
            line: 0,
            message: `the module could not be parsed: ${error.message} (line ${error.line})`,
          });
        return { records: [], unions: [], functions: [], outside: [...outside.values()] };
      }
      // A name asked for that is no module-level declaration (inside a namespace, say) is reported, not thrown.
      for (const name of functions ?? [])
        if (!declared.has(name))
          outside.set(name, {
            name,
            line: 0,
            message: `the module declares no function ${name} at its top level`,
          });
      for (const [name, why] of own.untrusted) if (!outside.has(name)) outside.set(name, why);
      // The module's own declared types first, in their order, so a record literal of no declared type
      // is matched against every record the module declares, and a record belongs to the union declared
      // first. A declared type the subset does not take is left out here; a function using it says why.
      const types = new SubsetTypes(checker);
      const skip = Symbol("outside");
      for (const st of sf.statements) {
        if (!is.isInterfaceDeclaration(st) && !is.isTypeAliasDeclaration(st)) continue;
        if (st.typeParameters) continue; // a generic alias is read where it is instantiated
        const symbol = checker.getSymbolAtLocation(st.name);
        if (!symbol) continue;
        try {
          types.of(checker.getDeclaredTypeOfSymbol(symbol), () => {
            throw skip;
          });
        } catch (err) {
          if (err !== skip) throw err;
        }
      }
      // Pass 2: signatures, so every function's return type is known before any body is read.
      const { ctx, signatures } = moduleContext(types.records);
      const names: Names = {
        callable: (n) => declared.has(n) && !generic.has(n),
        target: (n) => n,
        declared: (n) => declared.has(n),
        spec: false,
      };
      const typeSource: TypeSource = {
        annotation: (node, refuse) => types.of(checker.getTypeAtLocation(node), refuse),
        contextual: (node) => contextualType(checker, types, node),
      };
      const inline = inliner({
        checker,
        types,
        typeSource,
        ctx,
        module: sf,
        own,
        parseError,
        typeErrors,
      });
      const reader = new ExprReader(sf, names, typeSource, ctx, undefined, inline);
      const heads: Head[] = [];
      for (const [name, decl] of declarations) {
        try {
          if (overloaded.has(name))
            reader.fail(`${name} is declared more than once (overloads)`, decl.statement);
          const h = head(reader, types, checker, decl);
          // Callers of an assigned function still type-check against its declaration; they are then outside with it.
          signatures.set(name, { params: h.params, returns: h.returns });
          if (!outside.has(name)) heads.push(h);
        } catch (err) {
          if (!(err instanceof OutsideSubset)) throw err;
          if (!outside.has(name)) outside.set(name, { name, line: err.line, message: err.message });
        }
      }
      // Pass 3: bodies.
      const read = new Map<string, SubsetFunction>();
      for (const h of heads) {
        try {
          read.set(h.name, declaration(reader, h));
        } catch (err) {
          if (!(err instanceof OutsideSubset)) throw err;
          outside.set(h.name, { name: h.name, line: err.line, message: err.message });
        }
      }
      closeOverCallees(read, outside);
      // Recursion is in the subset as structural recursion on a list (`structuralOn`), a function calling
      // itself directly; any other recursion is outside, and so are its callers.
      const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
        const fn = read.get(from);
        if (!fn) return false;
        for (const c of callees(fn.body)) {
          if (c === target) return true;
          if (!seen.has(c)) {
            seen.add(c);
            if (reaches(c, target, seen)) return true;
          }
        }
        return false;
      };
      for (const [name, fn] of [...read])
        if (reaches(name, name)) {
          const direct = [...callees(fn.body)].every((c) => c === name || !reaches(c, name));
          const on = direct ? structuralOn(fn) : undefined;
          if (on !== undefined) {
            read.set(name, { ...fn, structural: on });
            continue;
          }
          read.delete(name);
          outside.set(name, {
            name,
            line: fn.line,
            message: `${name} is recursive in a way the subset does not take: it takes a function calling itself on a list parameter's slice(1), after a first test of that list's length against 0 (if (xs.length === 0) return …)`,
          });
        }
      closeOverCallees(read, outside);
      // Callees before callers, whatever the source order: Lean needs a definition before its use.
      const ordered: SubsetFunction[] = [];
      const placed = new Set<string>();
      while (ordered.length < read.size)
        // A structurally recursive function calls itself: that callee needs no placing first.
        for (const [name, fn] of read)
          if (
            !placed.has(name) &&
            [...callees(fn.body)].every((c) => c === name || placed.has(c))
          ) {
            ordered.push(fn);
            placed.add(name);
          }
      return {
        records: [...types.records.values()],
        unions: types.unions,
        functions: ordered,
        outside: [...outside.values()],
      };
    },
  );
}

/** A caller of a function outside the subset is outside it too, however many steps away. */
function closeOverCallees(
  read: Map<string, SubsetFunction>,
  outside: Map<string, OutsideFunction>,
): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, fn] of read) {
      const bad = [...callees(fn.body)].find((c) => outside.has(c));
      if (bad === undefined) continue;
      read.delete(name);
      outside.set(name, {
        name,
        line: fn.line,
        message: `calls ${bad}, which is outside the subset: ${outside.get(bad)?.message}`,
      });
      changed = true;
    }
  }
}

/**
 * A reader over text that is not the module: with `aliases`, the text is
 * a spec file's, whose names for the module's functions are its own
 * imports and nothing else; without, the text sees the module's names.
 * No compiler stands behind the text, so a `const` annotation is read
 * from its syntax against the module's declared types, and a record
 * literal has no contextual type. Lines are not reported: the text's
 * position is the caller's to know.
 */
function arrowReader(
  sf: SourceFile,
  module: SubsetModule,
  aliases?: ReadonlyMap<string, string>,
): ExprReader {
  const records = new Map(module.records.map((rec) => [rec.name, rec]));
  const unionNames = new Set(module.unions.map((u) => u.name));
  const inSubset = new Set(module.functions.map((f) => f.name));
  let names: Names;
  if (aliases) {
    const declared = new Set(aliases.keys());
    const callable = new Set(
      [...aliases].filter(([, fn]) => inSubset.has(fn)).map(([local]) => local),
    );
    names = {
      callable: (n) => callable.has(n),
      target: (n) => aliases.get(n) ?? n,
      declared: (n) => declared.has(n),
      spec: true,
    };
  } else {
    const declared = new Set([...inSubset, ...module.outside.map((o) => o.name)]);
    names = {
      callable: (n) => inSubset.has(n),
      target: (n) => n,
      declared: (n) => declared.has(n),
      spec: false,
    };
  }
  const recordNames = new Set(records.keys());
  const typeSource: TypeSource = {
    annotation: (node, refuse) => syntacticType(sf, node, recordNames, unionNames, refuse),
    contextual: () => undefined,
  };
  const signatures = new Map<string, CalleeSignature>(
    module.functions.map((f) => [f.name, { params: f.params, returns: f.returns }]),
  );
  return new ExprReader(sf, names, typeSource, { records, signatures }, () => 0);
}

/** The one expression a fragment `(text)` parsed to, or why the text is not one expression. */
function fragmentExpression(sf: SourceFile): Expression {
  const [first, second] = sf.statements;
  if (second) throw new OutsideSubset(`unexpected ${textOf(sf, second)} after the expression`, 0);
  if (!first || !is.isExpressionStatement(first) || !is.isParenthesizedExpression(first.expression))
    throw new OutsideSubset("could not be parsed as an expression", 0);
  let broken: string | undefined;
  const visit = (node: Node): void => {
    if (broken !== undefined) return;
    if (is.isIdentifier(node) && node.text === "")
      broken = "could not be parsed (something is missing)";
    node.forEachChild(visit);
  };
  visit(first);
  if (broken !== undefined) throw new OutsideSubset(broken, 0);
  return first.expression.expression;
}

/**
 * One TypeScript expression (a claim's body, say) in a scope of typed
 * names, over a module already read. The whole text must be the
 * expression.
 */
export function readExpression(
  text: string,
  scope: ReadonlyMap<string, SubsetType>,
  module: SubsetModule,
  aliases?: ReadonlyMap<string, string>,
): Expr {
  return withSourceFile(`(${text}\n)`, (sf) => {
    const expr = fragmentExpression(sf);
    return arrowReader(sf, module, aliases).expression(expr, scope);
  });
}

/**
 * The body of a spec file's arrow (`when` or `ensures`) as a boolean
 * expression: an expression body as it is, a block body through the same
 * statement reader as a function body (`const`, `if`, early returns).
 * The scope maps the arrow's own parameter names to the binders' types;
 * `aliases` maps the spec file's local names to the module's functions,
 * and a free name that is neither is outside the subset: the spec file's
 * scope is its imports, never the module's.
 */
export function readArrowBody(
  arrow: Arrow,
  scope: ReadonlyMap<string, SubsetType>,
  module: SubsetModule,
  aliases: ReadonlyMap<string, string> = new Map(),
): Expr {
  if (!arrow.block)
    return withSourceFile(`(${arrow.body}\n)`, (sf) => {
      const expr = fragmentExpression(sf);
      const reader = arrowReader(sf, module, aliases);
      return reader.narrowed(reader.expression(expr, scope), scope, sf);
    });
  return withSourceFile(`{${arrow.body}\n}`, (sf) => {
    const block = blockOf(sf);
    if (!block) throw new OutsideSubset("could not be parsed as a block", 0);
    const reader = arrowReader(sf, module, aliases);
    return reader.narrowed(reader.block(block.statements, new Map(scope), block), scope, sf);
  });
}

/**
 * The list parameter a function recurses on structurally, or undefined:
 * its body is `if (p.length === 0) … else …` for a list parameter p, the
 * test and the first branch do not call it, and every call to it in the
 * other branch passes `p.slice(1)` for p. Lean takes such a definition as
 * a match on `[]` and `head :: tail`, recursing on the tail.
 */
function structuralOn(fn: SubsetFunction): number | undefined {
  const body = fn.body;
  if (body.kind !== "cond") return undefined;
  const t = body.test;
  if (t.kind !== "binary" || t.op !== "===") return undefined;
  const sides = [t.left, t.right];
  const zero = sides.find((x) => x.kind === "int" && x.value === "0");
  const len = sides.find((x) => x !== zero);
  if (!zero || len?.kind !== "field" || len.field !== "length" || len.object.kind !== "var")
    return undefined;
  const list = len.object.name;
  const at = fn.params.findIndex((p) => p.name === list && p.type.kind === "list");
  if (at < 0) return undefined;
  if (callees(t).has(fn.name) || callees(body.ifTrue).has(fn.name)) return undefined;
  const calls = selfCalls(body.ifFalse, fn.name);
  const onTail = (a: Expr | undefined) =>
    a?.kind === "tail" && a.list.kind === "var" && a.list.name === list;
  return calls.length > 0 && calls.every((c) => onTail(c.args[at])) ? at : undefined;
}

/** Every call to `name` in an expression. */
function selfCalls(e: Expr, name: string): Extract<Expr, { kind: "call" }>[] {
  const out: Extract<Expr, { kind: "call" }>[] = [];
  const walk = (x: Expr): void => {
    if (x.kind === "call" && x.callee === name) out.push(x);
    for (const child of children(x)) walk(child);
  };
  walk(e);
  return out;
}

/** An expression's direct subexpressions. */
export function children(e: Expr): Expr[] {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return [];
    case "narrow":
    case "narrowTag":
      return [e.body];
    case "neg":
    case "not":
    case "isInteger":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "cond":
      return [e.test, e.ifTrue, e.ifFalse];
    case "call":
      return [...e.args];
    case "field":
      return [e.object];
    case "record":
      return e.fields.map((f) => f.value);
    case "let":
      return [e.value, e.body];
    case "list":
      return [...e.items, ...(e.rest ? [e.rest] : [])];
    case "tail":
      return [e.list];
    case "headOr":
      return [e.list, e.fallback];
    case "iterate":
      return [e.list, e.body];
    case "fold":
      return [e.list, e.init, e.body];
  }
}

/** Whether an expression holds a node of the kinds named. */
function hasNode(e: Expr, kinds: ReadonlySet<Expr["kind"]>): boolean {
  if (kinds.has(e.kind)) return true;
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return false;
    case "narrow":
    case "narrowTag":
      return hasNode(e.body, kinds);
    case "neg":
    case "not":
    case "isInteger":
      return hasNode(e.operand, kinds);
    case "binary":
      return hasNode(e.left, kinds) || hasNode(e.right, kinds);
    case "cond":
      return hasNode(e.test, kinds) || hasNode(e.ifTrue, kinds) || hasNode(e.ifFalse, kinds);
    case "call":
      return e.args.some((a) => hasNode(a, kinds));
    case "field":
      return hasNode(e.object, kinds);
    case "record":
      return e.fields.some((f) => hasNode(f.value, kinds));
    case "let":
      return hasNode(e.value, kinds) || hasNode(e.body, kinds);
    case "list":
      return e.items.some((x) => hasNode(x, kinds)) || (e.rest ? hasNode(e.rest, kinds) : false);
    case "tail":
      return hasNode(e.list, kinds);
    case "headOr":
      return hasNode(e.list, kinds) || hasNode(e.fallback, kinds);
    case "iterate":
      return hasNode(e.list, kinds) || hasNode(e.body, kinds);
    case "fold":
      return hasNode(e.list, kinds) || hasNode(e.init, kinds) || hasNode(e.body, kinds);
  }
}

/**
 * The module as an engine that takes only some of the subset's types sees
 * it: records with a field of a type it does not take are dropped, and so
 * are functions whose signature holds one, whose body uses what the
 * types bring (`null`, narrowing), or which call such a function; each is
 * reported outside with `reason`.
 */
export function restrictModule(
  module: SubsetModule,
  takes: (t: SubsetType) => boolean,
  reason: string,
  /** Expression kinds a function's body may not hold here: by default what nullable types and unions bring. */
  bodies: ReadonlySet<Expr["kind"]> = new Set(["null", "narrow", "narrowTag"]),
): SubsetModule {
  // A record with a field the engine does not take is out, and so is a union with such a member, and
  // so, in turn, is a record with a field of that union: to a fixed point.
  const badRecords = new Set<string>();
  for (const u of module.unions)
    if (!takes({ kind: "union", name: u.name })) badRecords.add(`union:${u.name}`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const rec of module.records)
      if (
        !badRecords.has(rec.name) &&
        rec.fields.some((f) => !typeTaken(f.type, takes, badRecords))
      ) {
        badRecords.add(rec.name);
        changed = true;
      }
    for (const u of module.unions) {
      if (!badRecords.has(`union:${u.name}`) && u.members.some((m) => badRecords.has(m.record))) {
        badRecords.add(`union:${u.name}`);
        changed = true;
      }
      // A member of a dropped union stays a record of its own: every record has its own sort, so a
      // member of several unions does not go with one of them.
    }
  }
  const outside = new Map(module.outside.map((o) => [o.name, o]));
  const kept = new Map(module.functions.map((f) => [f.name, f]));
  const uses = (f: SubsetFunction) =>
    !f.params.every((p) => typeTaken(p.type, takes, badRecords)) ||
    !typeTaken(f.returns, takes, badRecords) ||
    annotations(f.body).some((t) => !typeTaken(t, takes, badRecords)) ||
    hasNode(f.body, bodies);
  for (const f of module.functions)
    if (uses(f)) {
      kept.delete(f.name);
      outside.set(f.name, { name: f.name, line: f.line, message: reason });
    }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, f] of kept) {
      const bad = [...callees(f.body)].find((c) => outside.has(c));
      if (bad === undefined) continue;
      kept.delete(name);
      outside.set(name, {
        name,
        line: f.line,
        message: `calls ${bad}, which is outside the engine's subset: ${outside.get(bad)?.message}`,
      });
      changed = true;
    }
  }
  return {
    // A kept record names only the unions kept with it.
    records: module.records
      .filter((r) => !badRecords.has(r.name))
      .map((r) => {
        const unions = r.unions?.filter((u) => !badRecords.has(`union:${u}`));
        if (unions === r.unions) return r;
        const { unions: _, ...rest } = r;
        return unions && unions.length > 0 ? { ...rest, unions } : rest;
      }),
    unions: module.unions.filter((u) => !badRecords.has(`union:${u.name}`)),
    functions: module.functions.filter((f) => kept.has(f.name)),
    outside: [...outside.values()],
  };
}

function typeTaken(
  t: SubsetType,
  takes: (t: SubsetType) => boolean,
  badRecords: ReadonlySet<string>,
): boolean {
  if (!takes(t)) return false;
  if (t.kind === "record") return !badRecords.has(t.name);
  if (t.kind === "union") return !badRecords.has(`union:${t.name}`);
  if (t.kind === "nullable") return typeTaken(t.inner, takes, badRecords);
  if (t.kind === "list") return typeTaken(t.element, takes, badRecords);
  return true;
}

/** The types a body's `const` annotations and its record literals' contexts name. */
function annotations(e: Expr, out: SubsetType[] = []): SubsetType[] {
  if ((e.kind === "let" || e.kind === "record") && e.type) out.push(e.type);
  for (const c of children(e)) annotations(c, out);
  return out;
}

/** An expression only lists bring. */
export type ListExpr = Extract<Expr, { kind: "list" | "tail" | "headOr" | "iterate" | "fold" }>;

/** The expression kinds only lists bring, for an engine that does not take them. */
export const listKinds: ReadonlySet<Expr["kind"]> = new Set<ListExpr["kind"]>([
  "list",
  "tail",
  "headOr",
  "iterate",
  "fold",
]);

/** Whether an expression is one only lists bring (a type guard over `listKinds`). */
export const isListExpr = (e: Expr): e is ListExpr => listKinds.has(e.kind);
