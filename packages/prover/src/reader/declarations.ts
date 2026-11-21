/**
 * A file's functions as declared: its top-level functions and which of
 * them may run something else (`fileFunctions`), a function's header and
 * body read against it (`head`, `declaration`), and why a range of a file
 * is not read: an error the compiler reports in it, or a directive that
 * hides one (`notCompiled`).
 */

import {
  type ArrowFunction,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  forEachLeadingCommentRange,
  forEachTrailingCommentRange,
  type Identifier,
  type Node,
  type SourceFile,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import type { Checker } from "typescript/sync";
import { type CompilerError, isAsync, isConst, lineAt, openParen } from "./compiler.ts";
import type { ExprReader } from "./expressions.ts";
import { directEval, isWritten, rebound } from "./rebinding.ts";
import {
  describe,
  type OutsideFunction,
  type Param,
  type SubsetFunction,
  type SubsetType,
} from "./tree.ts";
import type { SubsetTypes } from "./types.ts";
import { fits } from "./typing.ts";

/**
 * The first `@ts-ignore` or `@ts-expect-error` directive in a range of a
 * file, with its position: a comment shaped as the compiler reads one (the
 * directive opens a `//` comment, or the last line of a block comment),
 * found as the compiler finds comments, leading or trailing a node's
 * text, so the words in prose or in a string are not one. A comment
 * before a closing token alone (`/* … *\/ }`) is not seen; what it could
 * hide is on that token's line.
 */
function directiveIn(
  sf: SourceFile,
  start: number,
  end: number,
): { text: string; pos: number } | undefined {
  const text = sf.text;
  const singleLine = /^\/\/\/?\s*@ts-(ignore|expect-error)/;
  const lastLine = /^(?:\/|\*)*\s*@ts-(ignore|expect-error)/;
  let found: { text: string; pos: number } | undefined;
  const check = (pos: number, commentEnd: number): void => {
    if (found || pos < start || commentEnd > end) return;
    const comment = text.slice(pos, commentEnd);
    // The compiler trims the block comment's last line before looking (`trimStringStart`).
    const m = comment.startsWith("//")
      ? singleLine.exec(comment)
      : lastLine.exec(comment.slice(comment.lastIndexOf("\n") + 1).trimStart());
    if (m) found = { text: `@ts-${m[1]}`, pos };
  };
  const visit = (node: Node): void => {
    if (found || node.end < start || node.pos > end) return;
    forEachLeadingCommentRange(text, node.pos, check);
    forEachTrailingCommentRange(text, node.end, check);
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/**
 * The line of a `@ts-nocheck` directive at the top of a file, which turns
 * the compiler's checks off for all of it: as the compiler reads it, a
 * `//` comment opening with it, the last of it and `@ts-check` deciding.
 */
function noCheckDirective(sf: SourceFile): number | undefined {
  const text = sf.text;
  const from = text.startsWith("#!") ? Math.max(0, text.indexOf("\n")) : 0;
  let line: number | undefined;
  forEachLeadingCommentRange(text, from, (pos, end) => {
    const m = /^\/\/\/?\s*@ts-(check|nocheck)\b/.exec(text.slice(pos, end));
    if (m) line = m[1] === "nocheck" ? sf.getLineAndCharacterOfPosition(pos).line + 1 : undefined;
  });
  return line;
}

/** A declaration's text, and the statement's leading comments, where a directive reaches its first line. */
export interface DeclaredRange {
  readonly start: number;
  readonly end: number;
  readonly lead?: { readonly start: number; readonly end: number };
}

/**
 * Why a range of a file is not read: the first error the compiler reports
 * inside it, or a `@ts-ignore` or `@ts-expect-error` directive in it or
 * in the leading comments (where a directive reaches the first line),
 * which hides one from the reader. Undefined when the range is clean.
 */
export function notCompiled(
  sf: SourceFile,
  typeErrors: (path: string) => readonly CompilerError[],
  { start, end, lead }: DeclaredRange,
): { message: string; line: number } | undefined {
  const error = typeErrors(sf.fileName).find((e) => e.pos < end && e.end > start);
  if (error)
    return { message: `the compiler reports an error: ${error.message}`, line: error.line };
  const silenced =
    (lead ? directiveIn(sf, lead.start, lead.end) : undefined) ?? directiveIn(sf, start, end);
  if (silenced)
    return {
      message: `a ${silenced.text} comment, which hides a compiler error from the reader`,
      line: sf.getLineAndCharacterOfPosition(silenced.pos).line + 1,
    };
  return undefined;
}

/**
 * Where a declared function's errors are looked for: its own declaration
 * (in a `const` list, a sibling's error, or a directive in a sibling's
 * body, is the sibling's), and for directives the statement's leading
 * comments too, since a directive above the statement reaches its first
 * line, siblings included.
 */
export function rangeOf(d: Declared): DeclaredRange {
  let declaration: Node = d.node;
  while (!is.isFunctionDeclaration(declaration) && !is.isVariableDeclaration(declaration))
    declaration = declaration.parent;
  const sf = d.statement.getSourceFile();
  return {
    start: declaration.pos,
    end: declaration.end,
    lead: { start: d.statement.pos, end: d.statement.getStart(sf) },
  };
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
export interface Declared {
  readonly name: Identifier;
  readonly node: FunctionNode;
  readonly statement: Node;
}

/** A function's header read: its typed parameters and return type, with the body still to read. */
export interface Head {
  readonly name: string;
  readonly decl: FunctionNode;
  readonly params: readonly Param[];
  readonly returns: SubsetType;
  readonly line: number;
  readonly offset: number;
}

/** The parameter names of a function the subset can take at all: synchronous, no generator, plain parameters. */
export function shape(reader: ExprReader, decl: FunctionNode): string[] {
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
export function head(reader: ExprReader, types: SubsetTypes, checker: Checker, d: Declared): Head {
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
export function declaration(reader: ExprReader, h: Head): SubsetFunction {
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
export interface FileFunctions {
  readonly declarations: ReadonlyMap<string, Declared>;
  readonly overloaded: ReadonlySet<string>;
  readonly untrusted: ReadonlyMap<string, OutsideFunction>;
  /** What puts the whole file outside, functions and constants alike: eval, a built-in assigned to, or the compiler's checks turned off. */
  readonly tainted?: { readonly line: number; readonly message: string };
}

/**
 * A file's top-level functions: declarations, and the arrows module-level
 * consts hold. A binding that may be reassigned (let, var) or holds a
 * function expression is listed, for its callers' typing, and untrusted;
 * so is every function of a file mentioning eval directly or assigning to
 * a built-in, and a function the file assigns to.
 */
export function fileFunctions(
  sf: SourceFile,
  checker: Checker,
  standardGlobal: (id: Identifier) => boolean,
): FileFunctions {
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
  // function outside: `eval(…)`, `(eval)(…)`, inside a template substitution alike. So does a
  // `@ts-nocheck` comment, which turns off the compiler's checks the reader relies on, and a direct
  // assignment to a built-in the subset reads as standard (`Math.floor = …`, `Array.prototype.map =
  // …`), wherever it is in the file: once it has run, the file's functions compute something else.
  // The engines state the assumption that nothing the reader does not see does this.
  const evalLine = directEval(sf);
  const noCheck = noCheckDirective(sf);
  const patched = rebound(sf, checker, standardGlobal);
  const tainted =
    evalLine !== undefined
      ? {
          line: evalLine,
          message: "the module mentions eval directly, which can rebind any of its declarations",
        }
      : noCheck !== undefined
        ? {
            line: noCheck,
            message:
              "its file has a @ts-nocheck comment, which turns off the compiler's checks the reader relies on",
          }
        : patched !== undefined
          ? {
              line: patched.line,
              message: `its file assigns to ${patched.target} (line ${patched.line}), so the built-ins its functions use may not be the standard ones`,
            }
          : undefined;
  if (tainted) for (const name of declarations.keys()) untrusted.set(name, { name, ...tainted });
  for (const [name, line] of assigned(sf, checker, declarations))
    if (!untrusted.has(name))
      untrusted.set(name, {
        name,
        line,
        message: `${name} is assigned in the module, so what runs under its name may not be its declaration`,
      });
  return { declarations, overloaded, untrusted, ...(tainted ? { tainted } : {}) };
}
