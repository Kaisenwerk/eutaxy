/**
 * Function bodies and spec arrows read from the compiler's syntax tree
 * into the subset's `Expr`: `const` bindings, `if` with early returns,
 * `return`, and expressions from arithmetic, comparisons, `&& || !`, the
 * conditional operator, record and array literals, field reads, list
 * methods and calls to the module's own functions. What a name stands
 * for comes from the scope (parameters and consts) and from `Names`: the
 * module's own functions when the text is the module, the spec file's
 * imports when it is an arrow. Anything else is `OutsideSubset` with the
 * construct named and its line.
 */

import {
  type ArrowFunction,
  type BinaryExpression,
  type Block,
  type CallExpression,
  type Expression,
  type Identifier,
  type Node,
  type ObjectLiteralExpression,
  type ReturnStatement,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type TypeNode,
} from "typescript/ast";
import * as is from "typescript/ast/is";
import { isAsync, isConst, kindName, lineAt, textOf } from "./compiler.ts";
import {
  type BinaryOp,
  type Expr,
  hasLoneSurrogate,
  insertNarrows,
  OutsideSubset,
  type SubsetType,
  type TypeContext,
  tagOf,
  typeOf,
} from "./subset.ts";
import type { Refuse } from "./types.ts";

/**
 * A call to a function the text cannot call by name (a generic one, or one
 * imported from another file) read as that function's body, bound to the
 * arguments: undefined when the callee is no such function, so the call is
 * refused as before. `readArgs` reads the arguments in the caller's scope,
 * a record literal argument typed as the parameter it is passed for when
 * that type is given; `fail` refuses at the call.
 */
export type Inline = (
  call: CallExpression,
  callee: Identifier,
  scope: Scope,
  readArgs: (types: readonly (SubsetType | undefined)[]) => Expr[],
  fail: (what: string) => never,
) => Expr | undefined;

/** What the bare names of the text being read stand for, outside any local scope. */
export interface Names {
  /** A function the subset may call under this name. */
  readonly callable: (name: string) => boolean;
  /** The module function a callable name stands for (a spec file's local name resolves to the module's). */
  readonly target: (name: string) => string;
  /** A function the text may name at all, in the subset or not: for messages. */
  readonly declared: (name: string) => boolean;
  /** Whether the text is a spec file's, whose names are its imports, never the module's. */
  readonly spec: boolean;
}

/** Where the types a body mentions come from: the compiler for the module, the module's own declared types for an arrow. */
export interface TypeSource {
  /** The subset type a `const` annotation names. */
  readonly annotation: (node: TypeNode, refuse: Refuse) => SubsetType;
  /** The type the context gives a record literal, when the compiler knows one the subset takes. */
  readonly contextual: (node: ObjectLiteralExpression) => SubsetType | undefined;
}

export type Scope = ReadonlyMap<string, SubsetType>;

const binaryOps: Partial<Record<SyntaxKind, BinaryOp>> = {
  [SyntaxKind.PlusToken]: "+",
  [SyntaxKind.MinusToken]: "-",
  [SyntaxKind.AsteriskToken]: "*",
  [SyntaxKind.LessThanToken]: "<",
  [SyntaxKind.LessThanEqualsToken]: "<=",
  [SyntaxKind.GreaterThanToken]: ">",
  [SyntaxKind.GreaterThanEqualsToken]: ">=",
  [SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [SyntaxKind.AmpersandAmpersandToken]: "&&",
  [SyntaxKind.BarBarToken]: "||",
};

const methods = new Set(["slice", "map", "flatMap", "every", "some", "reduce"]);

/** The reader of one text: a function body, or an arrow of the spec file. */
export class ExprReader {
  readonly sf: SourceFile;
  readonly names: Names;
  readonly types: TypeSource;
  readonly ctx: TypeContext;
  /** The line a refusal reports for a node: the file's, or none for text whose position the caller knows. */
  private readonly lineOf: (node: Node) => number;
  private readonly inline: Inline | undefined;
  /** Record literals typed by the call they are passed to, in place of the compiler's contextual type. */
  private readonly typedAs = new Map<Node, SubsetType>();

  constructor(
    sf: SourceFile,
    names: Names,
    types: TypeSource,
    ctx: TypeContext,
    lineOf: (node: Node) => number = (node) => lineAt(sf, node),
    inline?: Inline,
  ) {
    this.sf = sf;
    this.names = names;
    this.types = types;
    this.ctx = ctx;
    this.lineOf = lineOf;
    this.inline = inline;
  }

  fail(what: string, at: Node): never {
    throw new OutsideSubset(what, this.lineOf(at));
  }

  /** `OutsideSubset` at a node, for a type read there. */
  refuseAt(at: Node): Refuse {
    return (what) => this.fail(what, at);
  }

  text(node: Node): string {
    return textOf(this.sf, node);
  }

  /** The expression with `narrow` nodes inserted where a null check guards a nullable name. */
  narrowed(e: Expr, scope: Scope, at: Node): Expr {
    return insertNarrows(e, scope, this.ctx, (m) => this.fail(m, at));
  }

  typeOfExpr(e: Expr, scope: Scope, at: Node, expected?: SubsetType): SubsetType {
    return typeOf(e, scope, this.ctx, (m) => this.fail(m, at), expected);
  }

  /**
   * A block's statements as one expression: `const` becomes `let`, `if (c)
   * return a; rest` a conditional, and the last statement must return:
   * every path ends in a `return`.
   */
  block(statements: readonly Statement[], scope: Scope, end: Node): Expr {
    return this.statements(statements, 0, scope, end);
  }

  private statements(statements: readonly Statement[], i: number, scope: Scope, end: Node): Expr {
    const s = statements[i];
    if (!s) this.fail("a path that does not return", end);
    if (is.isEmptyStatement(s)) return this.statements(statements, i + 1, scope, end);
    if (is.isVariableStatement(s)) {
      const list = s.declarationList;
      if (!isConst(list)) this.fail("a mutable binding (use const)", s);
      const [decl, second] = list.declarations;
      if (!decl || second) this.fail("several bindings in one const", s);
      if (!is.isIdentifier(decl.name)) this.fail("a destructured const", decl.name);
      const name = decl.name.text;
      // A const shadows a module function throughout its block, from before its own line (the temporal
      // dead zone): a call above it would throw where the reader would see the function. Refused outright.
      if (this.names.declared(name))
        this.fail(`const ${name} shadows the module's function ${name} in its block`, decl.name);
      if (scope.has(name))
        this.fail(`const ${name} redeclares a name already bound here`, decl.name);
      const annotated = decl.type
        ? this.types.annotation(decl.type, this.refuseAt(decl.type))
        : undefined;
      if (!decl.initializer) this.fail(`const ${name} without a value`, decl);
      const value = this.expression(decl.initializer, scope);
      // While reading, the scope carries names; types come from `typeOf` once null checks have narrowed
      // the tree, so an initializer under a guard is typed as the guard allows. The annotation is the
      // binding's type (a null initializer is then a nullable, not null); `typeOf` checks it fits.
      const inner = new Map(scope);
      inner.set(name, annotated ?? { kind: "null" });
      const body = this.statements(statements, i + 1, inner, end);
      return { kind: "let", name, value, body, ...(annotated ? { type: annotated } : {}) };
    }
    if (is.isIfStatement(s)) {
      const test = this.expression(s.expression, scope);
      const then = this.branch(s.thenStatement, scope);
      if (s.elseStatement) {
        const otherwise = this.branch(s.elseStatement, scope);
        const after = statements[i + 1];
        if (after) this.fail("statements after an if/else that both return", after);
        return { kind: "cond", test, ifTrue: then, ifFalse: otherwise };
      }
      return {
        kind: "cond",
        test,
        ifTrue: then,
        ifFalse: this.statements(statements, i + 1, scope, end),
      };
    }
    if (is.isReturnStatement(s)) {
      const after = statements[i + 1];
      // `return` then a line break: JavaScript inserts a semicolon and returns undefined.
      if (!s.expression && after) {
        const gap = this.sf.text.slice(
          s.getStart(this.sf) + "return".length,
          after.getStart(this.sf),
        );
        if (/[\n\r\u2028\u2029]/.test(gap))
          this.fail(
            "a line break after return (JavaScript inserts a semicolon and returns undefined)",
            s,
          );
      }
      const value = this.returned(s, scope);
      if (after) this.fail("statements after a return", after);
      return value;
    }
    if (
      is.isForStatement(s) ||
      is.isForOfStatement(s) ||
      is.isForInStatement(s) ||
      is.isWhileStatement(s) ||
      is.isDoStatement(s)
    )
      this.fail("a loop", s);
    if (is.isThrowStatement(s)) this.fail("throw", s);
    if (is.isSwitchStatement(s)) this.fail("switch", s);
    if (is.isTryStatement(s)) this.fail("try", s);
    if (is.isFunctionDeclaration(s)) this.fail("a nested function", s);
    this.fail(`statement starting with ${this.text(s).split(/\s/)[0] ?? kindName(s.kind)}`, s);
  }

  /** An `if` branch: `return e;` or `{ ...statements ending in return }`. */
  private branch(s: Statement, scope: Scope): Expr {
    if (is.isBlock(s)) return this.block(s.statements, scope, s);
    if (is.isReturnStatement(s)) return this.returned(s, scope);
    this.fail("an if branch that does not return", s);
  }

  /** `return e;`. A line break after `return` makes JavaScript return undefined: no value, refused. */
  private returned(s: ReturnStatement, scope: Scope): Expr {
    if (!s.expression) this.fail("a return without a value", s);
    return this.expression(s.expression, scope);
  }

  expression(node: Expression, scope: Scope): Expr {
    if (is.isParenthesizedExpression(node)) return this.expression(node.expression, scope);
    if (is.isIdentifier(node)) return this.identifier(node, scope);
    if (is.isNumericLiteral(node)) {
      const raw = this.text(node);
      if (!/^[0-9](_?[0-9])*$/.test(raw))
        this.fail(`the numeric literal ${raw} (integers in decimal only)`, node);
      return { kind: "int", value: raw.replace(/_/g, "") };
    }
    if (is.isBigIntLiteral(node)) this.fail(`the bigint literal ${this.text(node)}`, node);
    if (is.isStringLiteral(node)) {
      if (hasLoneSurrogate(node.text))
        this.fail("a string literal with a lone surrogate, which Lean's strings cannot hold", node);
      return { kind: "string", value: node.text };
    }
    if (is.isNoSubstitutionTemplateLiteral(node) || is.isTemplateExpression(node))
      this.fail("a template literal", node);
    if (is.isRegularExpressionLiteral(node)) this.fail("a regular expression", node);
    if (node.kind === SyntaxKind.TrueKeyword) return { kind: "bool", value: true };
    if (node.kind === SyntaxKind.FalseKeyword) return { kind: "bool", value: false };
    if (node.kind === SyntaxKind.NullKeyword) return { kind: "null" };
    if (is.isPrefixUnaryExpression(node)) {
      if (node.operator === SyntaxKind.ExclamationToken)
        return { kind: "not", operand: this.expression(node.operand, scope) };
      if (node.operator === SyntaxKind.MinusToken) {
        const operand = this.expression(node.operand, scope);
        // A negated literal stays a literal with its sign flipped, so -(-1) is 1, never the text `--1`.
        return operand.kind === "int"
          ? {
              kind: "int",
              value: operand.value.startsWith("-") ? operand.value.slice(1) : `-${operand.value}`,
            }
          : { kind: "neg", operand };
      }
      if (node.operator === SyntaxKind.PlusToken) this.fail("unary plus", node);
      this.fail(`the ${this.text(node).slice(0, 2)} operator`, node);
    }
    if (is.isPostfixUnaryExpression(node))
      this.fail(`the ${this.text(node).slice(-2)} operator`, node);
    if (is.isTypeOfExpression(node)) this.fail("the typeof operator", node);
    if (is.isVoidExpression(node)) this.fail("the void operator", node);
    if (is.isAwaitExpression(node)) this.fail("the await operator", node);
    if (is.isNewExpression(node)) this.fail("the new operator", node);
    if (is.isDeleteExpression(node)) this.fail("the delete operator", node);
    if (is.isBinaryExpression(node)) return this.binary(node, scope);
    if (is.isConditionalExpression(node))
      return {
        kind: "cond",
        test: this.expression(node.condition, scope),
        ifTrue: this.expression(node.whenTrue, scope),
        ifFalse: this.expression(node.whenFalse, scope),
      };
    if (is.isCallExpression(node)) return this.call(node, scope);
    if (is.isPropertyAccessExpression(node)) {
      if (node.questionDotToken) this.fail("optional chaining", node);
      if (!is.isIdentifier(node.name)) this.fail("a private field", node.name);
      return {
        kind: "field",
        object: this.expression(node.expression, scope),
        field: node.name.text,
      };
    }
    if (is.isElementAccessExpression(node)) {
      if (this.isHead(node))
        this.fail("xs[0] without ?? fallback (it is undefined on an empty list)", node);
      this.fail("index access other than xs[0] ?? fallback", node);
    }
    if (is.isObjectLiteralExpression(node)) return this.record(node, scope);
    if (is.isArrayLiteralExpression(node)) {
      const items: Expr[] = [];
      let rest: Expr | undefined;
      for (const item of node.elements) {
        if (rest) this.fail("a spread that is not last in an array literal", item);
        if (is.isSpreadElement(item)) rest = this.expression(item.expression, scope);
        else if (is.isOmittedExpression(item)) this.fail("a hole in an array literal", item);
        else items.push(this.expression(item, scope));
      }
      return { kind: "list", items, ...(rest ? { rest } : {}) };
    }
    if (is.isArrowFunction(node) || is.isFunctionExpression(node))
      this.fail("a function expression (the subset has callbacks of list methods only)", node);
    if (is.isAsExpression(node)) this.fail("the as operator", node);
    if (is.isSatisfiesExpression(node)) this.fail("the satisfies operator", node);
    if (is.isNonNullExpression(node)) this.fail("the ! assertion", node);
    if (is.isTypeAssertion(node)) this.fail("a type assertion", node);
    if (node.kind === SyntaxKind.ThisKeyword) this.fail("this", node);
    this.fail(`unexpected ${this.text(node) || kindName(node.kind)}`, node);
  }

  private identifier(node: Identifier, scope: Scope): Expr {
    const name = node.text;
    if (name === "undefined") this.fail("undefined (the subset has null)", node);
    if (scope.has(name) || this.names.declared(name)) return { kind: "var", name };
    this.fail(
      this.names.spec
        ? `${name}, which is neither a parameter, a const nor a function imported from the module beside the spec file`
        : `${name}, which is neither a parameter, a const nor a function of this module`,
      node,
    );
  }

  /** Whether an element access is `xs[0]`. */
  private isHead(node: Node): boolean {
    return (
      is.isElementAccessExpression(node) &&
      is.isNumericLiteral(node.argumentExpression) &&
      this.text(node.argumentExpression) === "0"
    );
  }

  private binary(node: BinaryExpression, scope: Scope): Expr {
    const kind = node.operatorToken.kind;
    const op = binaryOps[kind];
    if (op) {
      return {
        kind: "binary",
        op,
        left: this.expression(node.left, scope),
        right: this.expression(node.right, scope),
      };
    }
    if (kind === SyntaxKind.QuestionQuestionToken) {
      // `xs[0] ?? fallback` only: any other index may be past the end, which is undefined.
      if (is.isBinaryExpression(node.left) && node.left.operatorToken.kind === kind)
        this.fail("a chain of ??", node);
      if (is.isElementAccessExpression(node.left) && !this.isHead(node.left))
        this.fail("index access other than xs[0] ?? fallback", node.left);
      if (!is.isElementAccessExpression(node.left))
        this.fail(
          "?? after anything but xs[0] (write xs[0] ?? fallback, parenthesized where it meets other operators)",
          node,
        );
      if (node.left.questionDotToken) this.fail("optional chaining", node.left);
      return {
        kind: "headOr",
        list: this.expression(node.left.expression, scope),
        fallback: this.expression(node.right, scope),
      };
    }
    if (kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment)
      this.fail("an assignment", node);
    if (kind === SyntaxKind.CommaToken) this.fail("the comma operator", node);
    if (kind === SyntaxKind.InKeyword || kind === SyntaxKind.InstanceOfKeyword)
      this.fail(`the ${this.text(node.operatorToken)} operator`, node);
    this.fail(`the ${this.text(node.operatorToken)} operator`, node);
  }

  private call(node: CallExpression, scope: Scope): Expr {
    if (node.questionDotToken) this.fail("optional chaining", node);
    let callee = node.expression;
    while (is.isParenthesizedExpression(callee)) callee = callee.expression;
    if (is.isPropertyAccessExpression(callee)) {
      if (callee.questionDotToken) this.fail("optional chaining", callee);
      if (!is.isIdentifier(callee.name)) this.fail("a private method", callee.name);
      const method = callee.name.text;
      const receiver = callee.expression;
      if (
        is.isIdentifier(receiver) &&
        receiver.text === "Number" &&
        method === "isInteger" &&
        !scope.has("Number") &&
        !this.names.declared("Number")
      ) {
        const [arg, extra] = node.arguments;
        if (!arg || extra) this.fail("Number.isInteger takes one argument", node);
        return { kind: "isInteger", operand: this.expression(arg, scope) };
      }
      // The receiver first: `Math.abs` fails on `Math`, a name of nothing here, before its method.
      const list = this.expression(receiver, scope);
      if (!methods.has(method))
        this.fail(
          `the method ${method} (the subset has slice(1), map, flatMap, every, some and reduce)`,
          callee.name,
        );
      return this.method(node, list, method, scope);
    }
    if (!is.isIdentifier(callee)) this.fail("a call to a computed callee", callee);
    const name = callee.text;
    // A binder or local named like a function shadows it: the call is to a number, which throws.
    if (scope.has(name))
      this.fail(`a call to ${name}, which names a value here, not the module's function`, callee);
    if (!this.names.callable(name) && this.inline) {
      const readArgs = (types: readonly (SubsetType | undefined)[]): Expr[] =>
        node.arguments.map((a, i) => {
          if (is.isSpreadElement(a)) this.fail("a spread argument", a);
          const type = types[i];
          if (!type) return this.expression(a, scope);
          // The literals the argument evaluates to: itself, or a conditional's branches.
          const literals: Node[] = [];
          const collect = (e: Expression): void => {
            if (is.isParenthesizedExpression(e)) collect(e.expression);
            else if (is.isConditionalExpression(e)) {
              collect(e.whenTrue);
              collect(e.whenFalse);
            } else if (is.isObjectLiteralExpression(e)) literals.push(e);
          };
          collect(a);
          for (const l of literals) this.typedAs.set(l, type);
          try {
            return this.expression(a, scope);
          } finally {
            for (const l of literals) this.typedAs.delete(l);
          }
        });
      const inlined = this.inline(node, callee, scope, readArgs, (what) => this.fail(what, node));
      if (inlined) return inlined;
    }
    if (!this.names.declared(name)) this.identifier(callee, scope); // names nothing here: its message
    if (!this.names.callable(name))
      this.fail(`a call to ${name}, which is outside the subset`, callee);
    return {
      kind: "call",
      callee: this.names.target(name),
      args: node.arguments.map((a) => {
        if (is.isSpreadElement(a)) this.fail("a spread argument", a);
        return this.expression(a, scope);
      }),
    };
  }

  /** `(a, b) => body` or `a => body`, an expression body only; the names it binds go into scope. */
  private callback(
    node: Expression,
    scope: Scope,
    arity: number,
    what: string,
  ): { names: string[]; body: Expr } {
    if (!is.isArrowFunction(node)) this.fail(`${what} takes an arrow function`, node);
    const arrow: ArrowFunction = node;
    // An async callback returns a promise, truthy whatever the body computes.
    if (isAsync(arrow)) this.fail(`an async callback in ${what}`, arrow);
    const names: string[] = [];
    for (const p of arrow.parameters) {
      if (!is.isIdentifier(p.name)) this.fail(`a destructured parameter of ${what}'s callback`, p);
      if (p.type) this.fail(`a type annotation on ${what}'s parameter`, p.type);
      if (p.initializer) this.fail(`a default value on ${what}'s parameter`, p);
      if (p.dotDotDotToken) this.fail(`a rest parameter on ${what}'s callback`, p);
      names.push(p.name.text);
    }
    if (names.length === 0 || names.length > arity)
      this.fail(
        `${what} takes a callback of 1 to ${arity} parameter(s), given ${names.length}`,
        arrow,
      );
    for (const n of names)
      if (scope.has(n) || this.names.declared(n))
        this.fail(`${what}'s parameter ${n} shadows a name already bound here`, arrow);
    if (new Set(names).size !== names.length)
      this.fail(`${what}'s parameters repeat a name`, arrow);
    if (is.isBlock(arrow.body))
      this.fail(`a block body in ${what}'s callback (write an expression)`, arrow.body);
    const inner = new Map(scope);
    for (const n of names) inner.set(n, { kind: "null" });
    return { names, body: this.expression(arrow.body, inner) };
  }

  /** A method call on a list: slice(1), map, flatMap, every, some, reduce. */
  private method(node: CallExpression, list: Expr, name: string, scope: Scope): Expr {
    const args = node.arguments;
    if (name === "slice") {
      const [one, extra] = args;
      if (!one || extra || !is.isNumericLiteral(one) || this.text(one) !== "1")
        this.fail("slice with an argument other than 1", one ?? node);
      return { kind: "tail", list };
    }
    if (name === "reduce") {
      const [cb, init, extra] = args;
      if (!cb || !init || extra) this.fail("reduce takes a callback and an initial value", node);
      const { names, body } = this.callback(cb, scope, 2, "reduce");
      if (names.length !== 2) this.fail("reduce takes a callback of (accumulator, item)", cb);
      return {
        kind: "fold",
        list,
        acc: names[0] as string,
        item: names[1] as string,
        body,
        init: this.expression(init, scope),
      };
    }
    const [cb, extra] = args;
    if (!cb || extra) this.fail(`${name} takes one callback`, node);
    const { names, body } = this.callback(cb, scope, 2, name);
    return {
      kind: "iterate",
      op: name as "map" | "flatMap" | "every" | "some",
      list,
      item: names[0] as string,
      ...(names[1] === undefined ? {} : { index: names[1] }),
      body,
    };
  }

  private record(node: ObjectLiteralExpression, scope: Scope): Expr {
    const fields: { name: string; value: Expr }[] = [];
    for (const p of node.properties) {
      if (is.isSpreadAssignment(p)) this.fail("spread in a record literal", p);
      if (is.isShorthandPropertyAssignment(p)) {
        if (!is.isIdentifier(p.name))
          this.fail(`a key that is not a name: ${this.text(p.name)}`, p.name);
        const name = p.name.text;
        if (name === "__proto__")
          this.fail("a __proto__ key, which sets the prototype, not a field", p);
        if (!scope.has(name)) this.fail(`shorthand ${name} names nothing in scope`, p);
        fields.push({ name, value: { kind: "var", name } });
        continue;
      }
      if (!is.isPropertyAssignment(p)) this.fail(`a method ${this.text(p).split("(")[0] ?? ""}`, p);
      if (is.isComputedPropertyName(p.name)) this.fail("a computed key", p.name);
      if (!is.isIdentifier(p.name))
        this.fail(`a key that is not a name: ${this.text(p.name)}`, p.name);
      if (p.name.text === "__proto__")
        this.fail("a __proto__ key, which sets the prototype, not a field", p.name);
      fields.push({ name: p.name.text, value: this.expression(p.initializer, scope) });
    }
    const type = this.typedAs.get(node) ?? this.types.contextual(node);
    const literal = (fs: typeof fields): Expr => ({
      kind: "record",
      fields: fs,
      ...(type ? { type } : {}),
    });
    // A member of a union picked by a conditional tag (`{ type: c ? "a" : "b", at }`) is one literal
    // per branch: the conditional moves out, the other fields go into each as written. The fields
    // are pure, so evaluating the test first computes the same value.
    const tag = type?.kind === "union" ? tagOf(type.name, this.ctx) : undefined;
    const chosen = tag === undefined ? undefined : fields.find((f) => f.name === tag);
    if (chosen?.value.kind === "cond") {
      const split = (value: Expr): Expr =>
        value.kind === "cond"
          ? {
              kind: "cond",
              test: value.test,
              ifTrue: split(value.ifTrue),
              ifFalse: split(value.ifFalse),
            }
          : literal(fields.map((f) => (f === chosen ? { name: f.name, value } : f)));
      return split(chosen.value);
    }
    return literal(fields);
  }
}

/**
 * A `const` annotation inside a spec arrow, read from its syntax against
 * the module's declared types: no compiler stands behind an arrow's
 * text, so a name must be a record or union the module reads, and the
 * forms are the primitives, `null`, literals, unions of those and arrays.
 */
export function syntacticType(
  sf: SourceFile,
  node: TypeNode,
  records: ReadonlySet<string>,
  unions: ReadonlySet<string>,
  refuse: Refuse,
): SubsetType {
  const go = (n: TypeNode): SubsetType => syntacticType(sf, n, records, unions, refuse);
  if (is.isParenthesizedTypeNode(node)) return go(node.type);
  if (is.isTypeOperatorNode(node) && node.operator === SyntaxKind.ReadonlyKeyword) {
    if (!is.isArrayTypeNode(node.type))
      return refuse("readonly before a type that is not an array");
    return go(node.type);
  }
  if (is.isArrayTypeNode(node)) return { kind: "list", element: go(node.elementType) };
  if (node.kind === SyntaxKind.NumberKeyword) return { kind: "int" };
  if (node.kind === SyntaxKind.BooleanKeyword) return { kind: "bool" };
  if (node.kind === SyntaxKind.StringKeyword) return { kind: "string" };
  if (node.kind === SyntaxKind.UndefinedKeyword)
    return refuse("undefined in a type (the subset has null)");
  if (is.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (lit.kind === SyntaxKind.NullKeyword) return { kind: "null" };
    if (lit.kind === SyntaxKind.TrueKeyword || lit.kind === SyntaxKind.FalseKeyword)
      return { kind: "bool" };
    if (is.isStringLiteral(lit)) return { kind: "string" };
    return refuse(`the literal type ${textOf(sf, node)}`);
  }
  if (is.isTypeReferenceNode(node)) {
    if (node.typeArguments)
      return refuse(`type ${textOf(sf, node)} (a generic type in an arrow's const)`);
    if (!is.isIdentifier(node.typeName)) return refuse(`type ${textOf(sf, node)}`);
    const name = node.typeName.text;
    if (records.has(name)) return { kind: "record", name };
    if (unions.has(name)) return { kind: "union", name };
    return refuse(
      `type ${name} (the subset has number, boolean, string, null, and the module's own record types and unions)`,
    );
  }
  if (is.isUnionTypeNode(node)) {
    const members = node.types.map(go);
    const nulls = members.filter((m) => m.kind === "null");
    const rest = members.filter((m) => m.kind !== "null");
    const first = rest[0];
    if (!first) return refuse("null alone is not a type the subset takes");
    if (!rest.every((m) => JSON.stringify(m) === JSON.stringify(first)))
      return refuse("a union of several types (declare it as a type alias in the module)");
    if (nulls.length === 0) return first;
    return first.kind === "nullable" ? first : { kind: "nullable", inner: first };
  }
  return refuse(`type ${textOf(sf, node)}`);
}

/**
 * The block body of an arrow read from a parsed fragment: the statements
 * between the braces, every path returning.
 */
export function blockOf(sf: SourceFile): Block | undefined {
  const [first, second] = sf.statements;
  return first && !second && is.isBlock(first) ? first : undefined;
}
