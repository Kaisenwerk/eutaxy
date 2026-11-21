/**
 * Renaming: `renameVars` renames an expression's free names without
 * capture, moving the names it binds out of the way (`boundNames`,
 * `fresh`). A spec arrow's parameters become the binders', and an
 * inlined callee's names move away from its caller's.
 */

import type { Expr } from "./tree.ts";

/** Every name an expression binds or refers to: its variables and its lets. */
export function boundNames(e: Expr, out = new Set<string>()): Set<string> {
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
    case "floor":
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
export function fresh(name: string, taken: ReadonlySet<string>): string {
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
    case "floor":
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
