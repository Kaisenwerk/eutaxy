/**
 * What a file may rebind, found in its syntax: a direct `eval`, a write
 * to a name (`isWritten`), and a direct assignment to a global of the
 * standard library or a property of one (`rebound`). What such an
 * assignment could reach another way is `builtinsAssumption`.
 */

import {
  type AsExpression,
  type Identifier,
  type Node,
  type NonNullExpression,
  type ParenthesizedExpression,
  type SatisfiesExpression,
  type SourceFile,
  SyntaxKind,
  type TypeAssertion,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import type { Checker } from "typescript/sync";
import { lineAt, textOf } from "./compiler.ts";

/** The line of the first direct `eval` in the file: a mention that is not a property of something else. */
export function directEval(sf: SourceFile): number | undefined {
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

/** An expression TypeScript lets wrap another without changing what it names: parentheses and assertions. */
type Wrapper =
  | ParenthesizedExpression
  | NonNullExpression
  | AsExpression
  | SatisfiesExpression
  | TypeAssertion;

function isWrapper(n: Node): n is Wrapper {
  return (
    is.isParenthesizedExpression(n) ||
    is.isNonNullExpression(n) ||
    is.isAsExpression(n) ||
    is.isSatisfiesExpression(n) ||
    is.isTypeAssertion(n)
  );
}

/** Whether a node is written to: assigned, updated, or bound by a destructuring or a `for` head. */
export function isWritten(node: Node): boolean {
  let n: Node = node;
  for (;;) {
    const p: Node = n.parent;
    if (!p) return false;
    if (isWrapper(p) && p.expression === n) {
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

/** What every PROVEN rests on besides the engine's model: the reader's assumption about the built-ins. */
export const builtinsAssumption =
  "the built-ins the subset reads (Math, Number and the array methods) are the standard ones: a direct assignment to a global of the standard library or to a property of one, or through globalThis, self or window, in a read file is refused, but one made another way (Object.defineProperty, through an alias) or elsewhere (a polyfill, another module) is not seen";

/** Names a file reaches the globals through that the library the reads compile against does not declare. */
const globalObjects = new Set(["globalThis", "self", "window", "global"]);

/**
 * The first direct assignment (or `delete`) in a file whose target is a
 * global of the compiler's standard library or a property of one, at any
 * depth (`Math.floor = …`, `Number["isInteger"] = …`, `Array.prototype.map
 * = …`, `Math = …`), or anything under `globalThis`, `self`, `window` or
 * `global`, with its line; inside a function or not. The chain's root is
 * resolved by the compiler, so a local's `prototype` field is the local's.
 * What reaches a built-in another way (`Object.defineProperty`, an alias)
 * is not seen: `builtinsAssumption` says so.
 */
export function rebound(
  sf: SourceFile,
  checker: Checker,
  standardGlobal: (id: Identifier) => boolean,
): { line: number; target: string } | undefined {
  let found: { line: number; target: string } | undefined;
  // `window` and its kin, by name, unless the name is a parameter or a local of some function here.
  const globalObject = (r: Identifier): boolean => {
    if (!globalObjects.has(r.text)) return false;
    const decl = checker.getSymbolAtLocation(r)?.valueDeclaration?.resolve();
    if (!decl) return true;
    if (decl.kind === SyntaxKind.Parameter) return false;
    return !(is.isVariableDeclaration(decl) && decl.parent.parent.parent !== decl.getSourceFile());
  };
  // The node a `delete` would take: the target with the wrappers around it.
  const outermost = (node: Node): Node => {
    let out: Node = node;
    for (let p: Node = out.parent; p && isWrapper(p) && p.expression === out; p = p.parent) out = p;
    return out;
  };
  const root = (node: Node): Node => {
    let n: Node = node;
    while (is.isPropertyAccessExpression(n) || is.isElementAccessExpression(n) || isWrapper(n))
      n = n.expression;
    return n;
  };
  const builtin = (node: Node): boolean => {
    const r = root(node);
    return is.isIdentifier(r) && (globalObject(r) || standardGlobal(r));
  };
  const visit = (node: Node): void => {
    if (found) return;
    if (
      (is.isPropertyAccessExpression(node) ||
        is.isElementAccessExpression(node) ||
        is.isIdentifier(node)) &&
      (isWritten(node) || is.isDeleteExpression(outermost(node).parent)) &&
      builtin(node)
    ) {
      found = { line: lineAt(sf, node), target: textOf(sf, node) };
      return;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}
