/**
 * Inlining: a call to a function the module cannot name as its own (a
 * generic one, or one of another file) read as the callee's body bound
 * to the arguments, and a module-level constant read as its value.
 */

import type { Identifier, Node, SourceFile } from "typescript/ast";
import * as is from "typescript/ast/is";
import { type Checker, SymbolFlags, type Type } from "typescript/sync";
import { type CompilerError, isConst } from "./compiler.ts";
import {
  type DeclaredRange,
  type FileFunctions,
  fileFunctions,
  notCompiled,
  rangeOf,
  shape,
} from "./declarations.ts";
import {
  type Constant,
  ExprReader,
  type Inline,
  type Names,
  type TypeSource,
} from "./expressions.ts";
import { boundNames, fresh, renameVars } from "./rename.ts";
import { describe, type Expr, OutsideSubset, type SubsetType } from "./tree.ts";
import type { SubsetTypes } from "./types.ts";
import { fits, type TypeContext } from "./typing.ts";

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
  readonly typeErrors: (path: string) => readonly CompilerError[];
  /** Whether an identifier names the global of its name (`Math`): the compiler resolves it to its standard library. */
  readonly standardGlobal: (id: Identifier) => boolean;
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
export function inliner(c: InlinerContext): { inline: Inline; constant: Constant } {
  const files = new Map<SourceFile, FileFunctions>([[c.module, c.own]]);
  const functionsOf = (file: SourceFile): FileFunctions => {
    let found = files.get(file);
    if (!found) {
      found = fileFunctions(file, c.checker, c.standardGlobal);
      files.set(file, found);
    }
    return found;
  };
  // Whether a declaration's text compiles, once per declaration however often it is read.
  const vetted = new Map<Node, { message: string; line: number } | undefined>();
  const vet = (
    file: SourceFile,
    key: Node,
    range: DeclaredRange,
  ): { message: string; line: number } | undefined => {
    if (!vetted.has(key)) vetted.set(key, notCompiled(file, c.typeErrors, range));
    return vetted.get(key);
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
    // A callee the compiler reports an error in computes something its text does not say.
    const bad = vet(file, d.node, rangeOf(d));
    if (bad)
      fail(
        `${where} is outside the subset: ${bad.message} (line ${bad.line}${file === c.module ? "" : " of its file"})`,
      );
    const signature = c.checker.getResolvedSignature(call);
    if (c.checker.isUnknownSignature(signature)) fail(`the call to ${where} does not resolve`);
    const fileNames: Names = {
      callable: () => false,
      target: (n) => n,
      declared: (n) => fns.declarations.has(n),
      spec: false,
      global: c.standardGlobal,
    };
    const typeSource: TypeSource = {
      annotation: (node, refuse) => c.types.of(concrete(c.checker.getTypeAtLocation(node)), refuse),
      contextual: c.typeSource.contextual,
    };
    const reader = new ExprReader(file, fileNames, typeSource, c.ctx, undefined, inline, constant);
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
  // The constants being read, innermost last: one that reaches itself is refused.
  const reading: string[] = [];
  const constant: Constant = (name, fail: (what: string) => never) => {
    let symbol = c.checker.getSymbolAtLocation(name);
    if (!symbol) return undefined;
    const imported = (symbol.flags & SymbolFlags.Alias) !== 0;
    if (imported) symbol = c.checker.getAliasedSymbol(symbol);
    const decl = symbol.valueDeclaration?.resolve();
    if (!decl || !is.isVariableDeclaration(decl) || !is.isIdentifier(decl.name)) return undefined;
    const list = decl.parent;
    const statement = list.parent;
    const file = decl.getSourceFile();
    // A module-level `const` only: a `let` or `var` may be rebound, a local is not this name.
    if (!is.isVariableDeclarationList(list) || !is.isVariableStatement(statement)) return undefined;
    // A local the compiler resolves the name to, which the reader has not bound, is declared later in
    // its block: a const there throws when used before its line, a var reads undefined.
    if (statement.parent !== file)
      fail(`${name.text}, which is declared after this use in its block`);
    const where = file === c.module ? decl.name.text : `${decl.name.text} (from ${file.fileName})`;
    // A global (Math, say) is declared in the compiler's own declaration files: no constant here.
    if (file.isDeclarationFile && !imported) return undefined;
    if (file.isDeclarationFile)
      fail(`${where} has no value to read: it is declared in a declaration file`);
    if (!isConst(list)) fail(`${where} is a module-level let or var, which may be rebound`);
    // A name the compiler rejects here (used before its declaration, say) is not read.
    const at = name.getSourceFile();
    const start = name.getStart(at);
    if (c.typeErrors(at.fileName).some((e) => e.pos < name.end && e.end > start))
      fail(`the compiler reports an error on ${name.text} here`);
    if (c.parseError(file.fileName)) fail(`${where} is in a file the compiler cannot parse`);
    const init = decl.initializer;
    if (!init) fail(`${where} has no initializer`);
    if (is.isArrowFunction(init) || is.isFunctionExpression(init)) return undefined;
    // The declaration as a whole: a declared type the value does not fit is reported on the name.
    const bad = vet(file, decl, {
      start: decl.pos,
      end: decl.end,
      lead: { start: statement.pos, end: statement.getStart(file) },
    });
    if (bad)
      fail(
        `${where} is outside the subset: ${bad.message} (line ${bad.line}${file === c.module ? "" : " of its file"})`,
      );
    const key = `${file.fileName}#${decl.name.text}`;
    if (reading.includes(key)) fail(`${where} is defined in terms of itself`);
    const fns = functionsOf(file);
    // A constant of a file that may rebind a built-in, or whose checks are off, is no value to trust.
    if (fns.tainted) fail(`${where} is outside the subset: ${fns.tainted.message}`);
    const fileNames: Names = {
      callable: () => false,
      target: (n) => n,
      declared: (n) => fns.declarations.has(n),
      spec: false,
      global: c.standardGlobal,
    };
    const reader = new ExprReader(
      file,
      fileNames,
      c.typeSource,
      c.ctx,
      undefined,
      undefined,
      constant,
    );
    reading.push(key);
    try {
      const value = reader.expression(init, new Map());
      if (!isValue(value))
        reader.fail(
          `${decl.name.text} holds something other than a number, boolean or string built from literals, operators and other such constants`,
          init,
        );
      return value;
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      fail(
        `${where}, read where it is used, is outside the subset: ${err.message} (line ${err.line} of its file)`,
      );
    } finally {
      reading.pop();
    }
  };
  return { inline, constant };
}

/**
 * Whether an expression is a value a constant may hold: literals of the
 * primitive types and the operators on them, with no name, call or record.
 */
function isValue(e: Expr): boolean {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
      return true;
    case "neg":
    case "not":
    case "isInteger":
    case "floor":
      return isValue(e.operand);
    case "binary":
      return isValue(e.left) && isValue(e.right);
    case "cond":
      return isValue(e.test) && isValue(e.ifTrue) && isValue(e.ifFalse);
    default:
      return false;
  }
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
