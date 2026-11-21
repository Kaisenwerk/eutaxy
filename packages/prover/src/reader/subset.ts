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
 * reads: a module through the compiler (`readSubset`), an expression or a
 * spec arrow from its text (`readExpression`, `readArrowBody`). The tree
 * is in `tree.ts`, typing in `typing.ts`, narrowing in `narrowing.ts`,
 * renaming in `rename.ts`, restriction in `restrict.ts`; `expressions.ts`
 * reads the syntax, `types.ts` the compiler's types, `declarations.ts` a
 * file's functions, and `inline.ts` the calls read as their callee's body.
 */

import type { Arrow } from "@eutaxy/spec";
import {
  type Expression,
  InternalSymbolName,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import type { Checker, Type } from "typescript/sync";
import { type InputFile, textOf, withProgram, withSourceFile } from "./compiler.ts";
import {
  type Declared,
  declaration,
  fileFunctions,
  type Head,
  head,
  notCompiled,
  rangeOf,
} from "./declarations.ts";
import { blockOf, ExprReader, type Names, syntacticType, type TypeSource } from "./expressions.ts";
import { inliner } from "./inline.ts";
import {
  callees,
  children,
  type Expr,
  type OutsideFunction,
  OutsideSubset,
  type RecordType,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type UnionType,
} from "./tree.ts";
import { SubsetTypes } from "./types.ts";
import type { CalleeSignature, TypeContext } from "./typing.ts";

/** The path a module read from text alone is compiled under: an import of another file does not resolve from it. */
const virtualModulePath = "/eutaxy/reader/module.ts";

export interface ReadSubsetOptions {
  /** The module's path on disk, under which its imports resolve. Without it the module stands alone. */
  readonly path?: string;
  /** Other files the read sees in place of (or beside) the files on disk, by path. */
  readonly files?: readonly InputFile[];
}

/** What typing a module's expressions needs, shared by every function read. */
function moduleContext(
  records: Map<string, RecordType>,
  unions: readonly UnionType[],
): {
  ctx: TypeContext;
  signatures: Map<string, CalleeSignature>;
} {
  const signatures = new Map<string, CalleeSignature>();
  return { ctx: { records, unions, signatures }, signatures };
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
    ({ checker, file, parseError, typeErrors, standardGlobal }) => {
      const sf = file(path);
      // Pass 1: the module's top-level functions, and what makes them untrustworthy. A generic one is
      // no function of the subset (no claim is stated over a type parameter); its callers read it inlined.
      const own = fileFunctions(sf, checker, standardGlobal);
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
      const { ctx, signatures } = moduleContext(types.records, types.unions);
      const names: Names = {
        callable: (n) => declared.has(n) && !generic.has(n),
        target: (n) => n,
        declared: (n) => declared.has(n),
        spec: false,
        global: standardGlobal,
      };
      const typeSource: TypeSource = {
        annotation: (node, refuse) => types.of(checker.getTypeAtLocation(node), refuse),
        contextual: (node) => contextualType(checker, types, node),
      };
      const { inline, constant } = inliner({
        checker,
        types,
        typeSource,
        ctx,
        module: sf,
        own,
        parseError,
        typeErrors,
        standardGlobal,
      });
      const reader = new ExprReader(sf, names, typeSource, ctx, undefined, inline, constant);
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
      // Pass 3: bodies. Text the compiler rejects (a const used before its declaration, which
      // throws where the reader sees a value) may compute something other than what it says: a
      // function read fine is still outside, with the compiler's message, when it has such an error.
      const read = new Map<string, SubsetFunction>();
      for (const h of heads) {
        try {
          const fn = declaration(reader, h);
          const bad = notCompiled(sf, typeErrors, rangeOf(declarations.get(h.name) as Declared));
          if (bad) throw new OutsideSubset(bad.message, bad.line);
          read.set(h.name, fn);
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
      global: () => true,
    };
  } else {
    const declared = new Set([...inSubset, ...module.outside.map((o) => o.name)]);
    names = {
      callable: (n) => inSubset.has(n),
      target: (n) => n,
      declared: (n) => declared.has(n),
      spec: false,
      global: () => true,
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
  return new ExprReader(
    sf,
    names,
    typeSource,
    { records, unions: module.unions, signatures },
    () => 0,
  );
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
 * scope is its imports, never the module's. `Math` and `Number` are the
 * globals wherever the arrow's own scope does not bind them: `readSpecs`
 * has checked that every built-in a claim names resolves to the standard
 * library in the spec file.
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
