/**
 * `restrictModule`: the module as an engine that takes only some of the
 * subset's types sees it.
 */

import {
  callees,
  children,
  type Expr,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
} from "./tree.ts";

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
    case "floor":
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
  /** A body the engine refuses for what it computes, not its kinds or types (a division, say). */
  refused?: (body: Expr) => boolean,
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
    hasNode(f.body, bodies) ||
    refused?.(f.body) === true;
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
