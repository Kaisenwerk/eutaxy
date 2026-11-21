/**
 * Narrowing: what a test tells about a name where it holds or fails. A
 * comparison against `null` narrows a nullable name (`narrowsOf`), a test
 * of a union's tag narrows the name to that member (`tagNarrowsOf`), and
 * `insertNarrows` wraps the branches a test guards in `narrow` and
 * `narrowTag` nodes, so typing and the engines see the narrowed name.
 */

import type { Expr, RecordType, SubsetType } from "./tree.ts";
import { elementOf, iterateScope, membersIn, type TypeContext, typeOf } from "./typing.ts";

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

/**
 * The field that tells a union's members apart, as the union names it: the
 * one the types read chose (`UnionType.tag`), which the engines encode by.
 * Re-deriving it from the member records could pick another field where two
 * discriminate, and the reader would then refuse the test the engines take.
 */
export function tagOf(union: string, ctx: TypeContext): string | undefined {
  return ctx.unions.find((u) => u.name === union)?.tag;
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
  // Where JavaScript tests truthiness (a condition, the operand of `!`), a nullable record or union
  // is falsy exactly when it is null, since an object is always truthy: `c` there is `c !== null`,
  // which then narrows as a null check does. A nullable number or string is no object, and stays.
  const probe = Symbol("untyped");
  const condition = (x: Expr, sc: ReadonlyMap<string, SubsetType>): Expr => {
    if (x.kind === "binary" && (x.op === "&&" || x.op === "||"))
      return { ...x, left: condition(x.left, sc), right: condition(x.right, sc) };
    if (x.kind === "not") return { kind: "not", operand: condition(x.operand, sc) };
    let t: SubsetType;
    try {
      t = typeOf(x, sc, ctx, () => {
        throw probe;
      });
    } catch (err) {
      if (err === probe) return x;
      throw err;
    }
    if (t.kind === "nullable" && (t.inner.kind === "record" || t.inner.kind === "union"))
      return { kind: "binary", op: "!==", left: x, right: { kind: "null" } };
    return x;
  };
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
    case "not":
      return { kind: "not", operand: go(condition(e.operand, scope), scope) };
    case "neg":
    case "isInteger":
    case "floor":
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
      const test = go(condition(e.test, scope), scope);
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
