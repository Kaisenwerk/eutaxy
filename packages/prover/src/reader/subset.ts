/**
 * The pure TypeScript subset the first-party engines accept, read into a
 * small tree: exported functions over `number` (as unbounded integers),
 * `boolean` and `string`, returning those or a record type declared in the
 * same module;
 * bodies made of `const` bindings, `if` with early returns, `return`, and
 * expressions from integer arithmetic (`+ - *`), comparisons, `&& || !`,
 * the conditional operator, record literals and field reads, and calls to
 * the module's own functions. Anything else is `OutsideSubset`, with the
 * construct named: the subset is specified by the contract corpus and
 * widens one characterised class at a time.
 */

import type { Arrow } from "@eutaxy/spec";
import { type Token, TokenizeError, templateSubstitutions, tokenize } from "./tokens.ts";

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
  | { readonly kind: "record"; readonly name: string };

export interface Field {
  readonly name: string;
  readonly type: SubsetType;
}

export interface RecordType {
  readonly name: string;
  readonly fields: readonly Field[];
}

export type BinaryOp = "+" | "-" | "*" | "<" | "<=" | ">" | ">=" | "===" | "!==" | "&&" | "||";

export type Expr =
  | { readonly kind: "int"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "var"; readonly name: string }
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
    }
  | { readonly kind: "let"; readonly name: string; readonly value: Expr; readonly body: Expr };

export interface Param {
  readonly name: string;
  readonly type: SubsetType;
}

/** A function's header, with the token index its body starts at. */
interface Signature {
  readonly name: string;
  readonly params: readonly Param[];
  readonly returns: SubsetType;
  readonly line: number;
  readonly offset: number;
  readonly body: number;
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
}

/** A function the subset does not take, and why. */
export interface OutsideFunction {
  readonly name: string;
  readonly line: number;
  readonly message: string;
}

export interface SubsetModule {
  readonly records: readonly RecordType[];
  /** The functions in the subset, in source order, callees before callers. */
  readonly functions: readonly SubsetFunction[];
  /** The module's other functions: outside the subset themselves, or calling one that is. */
  readonly outside: readonly OutsideFunction[];
}

/** Binary operators by precedence, loosest first; all left-associative here. */
const levels: readonly (readonly BinaryOp[])[] = [
  ["||"],
  ["&&"],
  ["===", "!=="],
  ["<", "<=", ">", ">="],
  ["+", "-"],
  ["*"],
];

class Reader {
  at = 0;
  readonly tokens: readonly Token[];
  private readonly lineOf: (offset: number) => number;
  constructor(tokens: readonly Token[], lineOf: (offset: number) => number) {
    this.tokens = tokens;
    this.lineOf = lineOf;
  }

  peek(n = 0): Token | undefined {
    return this.tokens[this.at + n];
  }

  line(t: Token | undefined = this.peek()): number {
    return t ? this.lineOf(t.start) : this.lineOf(this.tokens.at(-1)?.end ?? 0);
  }

  fail(what: string, t: Token | undefined = this.peek()): never {
    throw new OutsideSubset(what, this.line(t));
  }

  isPunct(text: string, n = 0): boolean {
    const t = this.peek(n);
    return t?.kind === "punct" && t.text === text;
  }

  isWord(text: string, n = 0): boolean {
    const t = this.peek(n);
    return t?.kind === "ident" && t.text === text;
  }

  take(): Token {
    const t = this.peek();
    if (!t) this.fail("the module ends early");
    this.at++;
    return t;
  }

  expectPunct(text: string): void {
    if (!this.isPunct(text)) this.fail(`expected ${text}, found ${this.peek()?.text ?? "the end"}`);
    this.at++;
  }

  ident(): string {
    const t = this.peek();
    if (t?.kind !== "ident") this.fail(`expected a name, found ${t?.text ?? "the end"}`);
    this.at++;
    return t.text;
  }
}

/** Whether a string holds a surrogate code unit without its pair: no Lean character corresponds to it. */
export function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/**
 * The value of a string literal token. Simple escapes and `\xHH`, `\uHHHH`,
 * `\u{H…}` are decoded; a line continuation, an octal escape or a lone
 * surrogate (which Lean's strings cannot hold) is outside the subset.
 */
function stringLiteralValue(text: string, r: Reader, t: Token): string {
  const body = text.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
      "\\": "\\",
      '"': '"',
      "'": "'",
    };
    if (e !== undefined && e in simple && !(e === "0" && /[0-9]/.test(body[i + 1] ?? ""))) {
      out += simple[e];
      continue;
    }
    if (e === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    if (e === "u") {
      const m = /^\{([0-9a-fA-F]{1,6})\}|^([0-9a-fA-F]{4})/.exec(body.slice(i + 1));
      if (m) {
        const code = Number.parseInt((m[1] ?? m[2]) as string, 16);
        if (code > 0x10ffff) r.fail(`a code point escape beyond U+10FFFF in a string literal`, t);
        out += String.fromCodePoint(code);
        i += m[0].length;
        continue;
      }
    }
    r.fail(`an escape sequence \\${e ?? ""} in a string literal`, t);
  }
  if (hasLoneSurrogate(out))
    r.fail("a string literal with a lone surrogate, which Lean's strings cannot hold", t);
  return out;
}

/** Record types the module declares but the subset does not take, with why. */
type BadRecords = ReadonlyMap<string, string>;

function typeAnnotation(
  r: Reader,
  records: ReadonlySet<string>,
  bad: BadRecords = new Map(),
): SubsetType {
  const t = r.take();
  if (t.kind === "string") {
    // A union of string literals is a string whose values the module restricts; the proof covers every
    // string, which is more than the type admits. `null` or `undefined` in the union is outside.
    while (r.isPunct("|")) {
      r.at++;
      const next = r.take();
      if (next.kind !== "string")
        r.fail(
          `a union mixing string literals with ${next.text} (only string literals are read, as string)`,
          next,
        );
    }
    return { kind: "string" };
  }
  if (t.kind !== "ident") r.fail(`a type that is not a name: ${t.text}`, t);
  const why = bad.get(t.text);
  if (why !== undefined) r.fail(`record type ${t.text} is outside the subset: ${why}`, t);
  if (r.isPunct("[") || r.isPunct("<") || r.isPunct("|") || r.isPunct("&"))
    r.fail(
      `type ${t.text}${r.peek()?.text}… (arrays, generics, unions and intersections are outside the subset)`,
      t,
    );
  if (t.text === "number") return { kind: "int" };
  if (t.text === "boolean") return { kind: "bool" };
  if (t.text === "string") return { kind: "string" };
  if (records.has(t.text)) return { kind: "record", name: t.text };
  r.fail(
    `type ${t.text} (the subset has number, boolean, string and the module's own record types)`,
    t,
  );
}

/** Names a Lean structure declaration generates itself, which a field cannot take. */
const structureNames = new Set([
  "mk",
  "rec",
  "recOn",
  "casesOn",
  "noConfusion",
  "noConfusionType",
  "injEq",
]);

/** `interface Name { a: T; b: U }` or `type Name = { ... }` at the reader, after any `export`. */
function recordAt(r: Reader, records: ReadonlySet<string>): RecordType | undefined {
  const start = r.at;
  if (r.isWord("export")) r.at++;
  const alias = r.isWord("type");
  if (!r.isWord("interface") && !alias) {
    r.at = start;
    return undefined;
  }
  r.at++;
  const name = r.ident();
  if (alias) r.expectPunct("=");
  if (r.isWord("extends")) r.fail("interface inheritance", r.peek());
  r.expectPunct("{");
  const fields: Field[] = [];
  while (!r.isPunct("}")) {
    if (r.isWord("readonly")) r.at++;
    const fname = r.ident();
    if (r.isPunct("?")) r.fail(`optional field ${fname}`);
    if (structureNames.has(fname)) r.fail(`field ${fname} takes a name Lean's structures reserve`);
    if (fname === "__proto__") r.fail("a field named __proto__, which JavaScript treats specially");
    r.expectPunct(":");
    fields.push({ name: fname, type: typeAnnotation(r, records) });
    if (r.isPunct(";") || r.isPunct(",")) r.at++;
  }
  r.expectPunct("}");
  if (r.isPunct(";")) r.at++;
  return { name, fields };
}

/** Skip a balanced bracket group starting at the reader. */
function skipGroup(r: Reader): void {
  const open = r.take();
  const close = { "(": ")", "[": "]", "{": "}" }[open.text];
  let depth = 1;
  while (depth > 0) {
    const t = r.take();
    if (t.kind !== "punct") continue;
    if (t.text === open.text) depth++;
    else if (t.text === close) depth--;
  }
}

/**
 * Whether the `function` token at `i` starts a declaration: at the start of
 * the module or after a statement end, with `export` and `async` allowed in
 * front. A `function` after `=`, `(`, `,`, `return` or `:` is an
 * expression, whose name is its own, not the module's.
 */
function isDeclaration(
  tokens: readonly Token[],
  i: number,
  lineOf: (offset: number) => number,
): boolean {
  let k = i - 1;
  while (
    tokens[k]?.kind === "ident" &&
    ["async", "export", "default"].includes(tokens[k]?.text ?? "")
  )
    k--;
  const before = tokens[k];
  if (before === undefined) return true;
  if (before.kind === "punct" && (before.text === ";" || before.text === "}")) return true;
  // A line break ends the previous statement (automatic semicolon insertion) unless that statement
  // is unfinished: an operator, an open bracket or a keyword still waiting for its operand.
  if (lineOf(before.end) === lineOf(tokens[i]?.start ?? 0)) return false;
  if (before.kind === "punct") return [")", "]", "++", "--"].includes(before.text);
  if (before.kind === "ident")
    return !"return typeof void new else case in of do yield await delete instanceof throw export default async"
      .split(" ")
      .includes(before.text);
  return true; // a literal
}

/**
 * Names used as values anywhere in the token stream, with the line of the
 * first use: a bare identifier that is not being called (`f(`), not a
 * property (`o.f`), not an object key (`{ f: … }`) and not the name in its
 * own declaration (`function f`, `const f`). A function used that way may
 * be reassigned, wrapped, aliased or passed on, so what runs under its name
 * is not what its declaration says; one rule covers every assignment form
 * (`f = …`, `f! = …`, `f as T = …`, `[f] = …`, `for (f of …)`) and the
 * aliases besides. Template substitutions are code too and are scanned.
 */
function valueUses(
  tokens: readonly Token[],
  lineOf: (offset: number) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  const isPunct = (t: Token | undefined, text: string) => t?.kind === "punct" && t.text === text;
  tokens.forEach((t, i) => {
    if (t.kind === "template") {
      for (const sub of templateSubstitutions(t.text))
        for (const [name, line] of valueUses(tokenize(sub), () => lineOf(t.start)))
          if (!out.has(name)) out.set(name, line);
      return;
    }
    if (t.kind !== "ident") return;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    if (isPunct(after, "(")) return; // a call
    if (isPunct(before, ".") || isPunct(before, "?.")) return; // a property of something else
    if (isPunct(after, ":") && (isPunct(before, "{") || isPunct(before, ","))) return; // an object key
    if (before?.kind === "ident" && ["function", "const", "let", "var"].includes(before.text))
      return;
    if (!out.has(t.text)) out.set(t.text, lineOf(t.start));
  });
  return out;
}

/** The line of the first token matching, template substitutions included (recursively). */
function firstLine(
  tokens: readonly Token[],
  lineOf: (offset: number) => number,
  matches: (t: Token, before: Token | undefined) => boolean,
): number | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "template") {
      for (const sub of templateSubstitutions(t.text)) {
        let inner: Token[];
        try {
          inner = tokenize(sub);
        } catch (err) {
          if (!(err instanceof TokenizeError)) throw err;
          return lineOf(t.start); // what cannot be read cannot be cleared
        }
        if (firstLine(inner, () => lineOf(t.start), matches) !== undefined) return lineOf(t.start);
      }
      continue;
    }
    if (matches(t, tokens[i - 1])) return lineOf(t.start);
  }
  return undefined;
}

/** The line of the first `eval` that is not a property of something else, template substitutions included. */
function mentionsEval(
  tokens: readonly Token[],
  lineOf: (offset: number) => number,
): number | undefined {
  return firstLine(
    tokens,
    lineOf,
    (t, before) =>
      t.kind === "ident" &&
      t.text === "eval" &&
      !(before?.kind === "punct" && (before.text === "." || before.text === "?.")),
  );
}

/** Words that start a declaration at module level, where a declaration the reader skips must stop. */
const declarationStarts = new Set(
  "export import function interface type const let var class enum declare async".split(" "),
);

/** Skip the rest of a declaration the subset does not take: to its `;`, or to the next declaration. */
function skipDeclaration(r: Reader): void {
  while (r.at < r.tokens.length) {
    const t = r.peek() as Token;
    if (t.kind === "punct" && t.text === ";") {
      r.at++;
      return;
    }
    if (t.kind === "punct" && ["(", "[", "{"].includes(t.text)) {
      skipGroup(r);
      continue;
    }
    if (t.kind === "ident" && declarationStarts.has(t.text)) return;
    r.at++;
  }
}

class FunctionParser {
  private readonly r: Reader;
  private readonly records: ReadonlyMap<string, RecordType>;
  private readonly functions: ReadonlySet<string>;
  /** Every function the module declares, in the subset or not, for messages. */
  private readonly declared: ReadonlySet<string>;
  private readonly badRecords: BadRecords;
  /** For a spec file's arrow: its local names for the module's functions (the keys are what `declared` and `functions` hold). */
  private readonly aliases: ReadonlyMap<string, string> | undefined;
  readonly signatures = new Map<string, CalleeSignature>();
  constructor(
    r: Reader,
    records: ReadonlyMap<string, RecordType>,
    functions: ReadonlySet<string>,
    badRecords: BadRecords = new Map(),
    declared: ReadonlySet<string> = functions,
    aliases?: ReadonlyMap<string, string>,
  ) {
    this.r = r;
    this.records = records;
    this.functions = functions;
    this.badRecords = badRecords;
    this.declared = declared;
    this.aliases = aliases;
  }

  /** `export function name(params): Type` at the reader, up to and including the body's `{`. */
  signature(): Signature {
    const r: Reader = this.r;
    const line = r.line();
    if (r.isWord("export")) r.at++;
    if (r.isWord("async")) r.fail("an async function (core functions are synchronous)");
    if (!r.isWord("function")) r.fail(`a declaration that is not a function: ${r.peek()?.text}`);
    r.at++;
    if (r.isPunct("*")) r.fail("a generator function");
    const name = r.ident();
    if (r.isPunct("<")) r.fail("type parameters");
    const offset = r.peek()?.start ?? -1;
    r.expectPunct("(");
    const params: Param[] = [];
    while (!r.isPunct(")")) {
      if (r.isPunct("{") || r.isPunct("[")) r.fail("a destructured parameter");
      if (r.isPunct("...")) r.fail("a rest parameter");
      const pname = r.ident();
      // `this: T` annotates the receiver and is erased; it is no argument the function is called with.
      if (pname === "this") r.fail("a this parameter (the receiver is not modelled)");
      if (r.isPunct("?")) r.fail(`optional parameter ${pname}`);
      if (!r.isPunct(":")) r.fail(`parameter ${pname} without a type`);
      r.at++;
      const type = typeAnnotation(r, new Set(this.records.keys()), this.badRecords);
      if (r.isPunct("=")) r.fail(`a default value for ${pname}`);
      params.push({ name: pname, type });
      if (r.isPunct(",")) r.at++;
    }
    r.expectPunct(")");
    if (!r.isPunct(":"))
      r.fail(`${name} without a return type (the subset needs it to name the record returned)`);
    r.at++;
    const returns = typeAnnotation(r, new Set(this.records.keys()), this.badRecords);
    r.expectPunct("{");
    return { name, params, returns, line, offset, body: r.at };
  }

  /** The function, its body read from where the signature stopped. */
  declaration(sig: Signature): SubsetFunction {
    this.r.at = sig.body;
    const scope = new Map(sig.params.map((p) => [p.name, p.type]));
    const body = this.block(scope, sig.returns);
    // Typing the whole body here: a record literal of no declared type, a field read on an integer or
    // a body of another type than declared are all outside the subset, found now rather than by Lean.
    const actual = this.typeOfExpr(body, scope);
    if (JSON.stringify(actual) !== JSON.stringify(sig.returns))
      this.r.fail(
        `${sig.name} returns a ${actual.kind === "record" ? actual.name : actual.kind} but declares ${sig.returns.kind === "record" ? sig.returns.name : sig.returns.kind}`,
      );
    return {
      name: sig.name,
      params: sig.params,
      returns: sig.returns,
      body,
      line: sig.line,
      offset: sig.offset,
    };
  }

  /**
   * The statements up to the closing `}` as one expression: `const` becomes
   * `let`, `if (c) return a; rest` becomes a conditional, and the last
   * statement must return. Every path ends in a `return`.
   */
  /** A statement block's statements up to its `}`, for an arrow's block body. */
  blockBody(scope: Map<string, SubsetType>, returns: SubsetType): Expr {
    return this.block(scope, returns);
  }

  private block(scope: Map<string, SubsetType>, returns: SubsetType): Expr {
    const r: Reader = this.r;
    if (r.isWord("const")) {
      r.at++;
      const name = r.ident();
      // A const shadows a module function throughout its block, from before its own line (the temporal
      // dead zone): a call above it would throw where the reader would see the function. Refused outright.
      if (this.declared.has(name))
        r.fail(`const ${name} shadows the module's function ${name} in its block`);
      if (scope.has(name)) r.fail(`const ${name} redeclares a name already bound here`);
      let annotated: SubsetType | undefined;
      if (r.isPunct(":")) {
        r.at++;
        annotated = typeAnnotation(r, new Set(this.records.keys()), this.badRecords);
      }
      r.expectPunct("=");
      const value = this.expression(scope);
      if (r.isPunct(";")) r.at++;
      const inner = new Map(scope);
      const inferred = this.typeOfExpr(value, scope);
      if (annotated && JSON.stringify(annotated) !== JSON.stringify(inferred))
        r.fail(
          `const ${name} is annotated ${describe(annotated)} but holds a ${describe(inferred)}`,
        );
      inner.set(name, inferred);
      const body = this.block(inner, returns);
      return { kind: "let", name, value, body };
    }
    if (r.isWord("if")) {
      r.at++;
      r.expectPunct("(");
      const test = this.expression(scope);
      r.expectPunct(")");
      const then = this.branch(scope, returns);
      let otherwise: Expr;
      if (r.isWord("else")) {
        r.at++;
        otherwise = this.branch(scope, returns);
        if (!r.isPunct("}")) r.fail("statements after an if/else that both return");
        r.at++; // the block's closing brace, as the return path consumes it
      } else otherwise = this.block(scope, returns);
      return { kind: "cond", test, ifTrue: then, ifFalse: otherwise };
    }
    if (r.isWord("return")) {
      const value = this.returned(scope);
      if (!r.isPunct("}")) r.fail("statements after a return");
      r.at++;
      return value;
    }
    if (r.isWord("let") || r.isWord("var")) r.fail("a mutable binding (use const)");
    if (r.isWord("for") || r.isWord("while") || r.isWord("do")) r.fail("a loop");
    if (r.isWord("throw")) r.fail("throw");
    if (r.isWord("switch")) r.fail("switch");
    if (r.isWord("try")) r.fail("try");
    if (r.isPunct("}")) r.fail("a path that does not return");
    r.fail(`statement starting with ${r.peek()?.text}`);
  }

  /** An `if` branch: `return e;` or `{ ...statements ending in return }`. */
  private branch(scope: Map<string, SubsetType>, returns: SubsetType): Expr {
    const r: Reader = this.r;
    if (r.isPunct("{")) {
      r.at++;
      return this.block(scope, returns);
    }
    if (!r.isWord("return")) r.fail("an if branch that does not return");
    return this.returned(scope);
  }

  /** `return e;` at the reader. A line break after `return` makes JavaScript return undefined, so it is refused. */
  private returned(scope: ReadonlyMap<string, SubsetType>): Expr {
    const r: Reader = this.r;
    const keyword = r.take();
    if (r.isPunct(";") || r.isPunct("}")) r.fail("a return without a value", keyword);
    if (r.line() !== r.line(keyword))
      r.fail(
        "a line break after return (JavaScript inserts a semicolon and returns undefined)",
        keyword,
      );
    const value = this.expression(scope);
    if (r.isPunct(";")) r.at++;
    return value;
  }

  expression(scope: ReadonlyMap<string, SubsetType>): Expr {
    const r: Reader = this.r;
    const left = this.binary(scope, 0);
    if (r.isPunct("?")) {
      r.at++;
      const then = this.expression(scope);
      r.expectPunct(":");
      const otherwise = this.expression(scope);
      return { kind: "cond", test: left, ifTrue: then, ifFalse: otherwise };
    }
    return left;
  }

  private binary(scope: ReadonlyMap<string, SubsetType>, level: number): Expr {
    if (level >= levels.length) return this.unary(scope);
    let left = this.binary(scope, level + 1);
    const ops = levels[level] as readonly BinaryOp[];
    for (;;) {
      const t = this.r.peek();
      if (t?.kind !== "punct" || !ops.includes(t.text as BinaryOp)) {
        if (
          t?.kind === "punct" &&
          ["==", "!=", "/", "%", "**", "??", "<<", ">>", "&", "|", "^"].includes(t.text)
        )
          this.r.fail(`the ${t.text} operator`, t);
        return left;
      }
      this.r.at++;
      const right = this.binary(scope, level + 1);
      left = { kind: "binary", op: t.text as BinaryOp, left, right };
    }
  }

  private unary(scope: ReadonlyMap<string, SubsetType>): Expr {
    const r: Reader = this.r;
    if (r.isPunct("!")) {
      r.at++;
      return { kind: "not", operand: this.unary(scope) };
    }
    if (r.isPunct("-")) {
      r.at++;
      const operand = this.unary(scope);
      // A negated literal stays a literal with its sign flipped, so -(-1) is 1, never the text `--1`.
      return operand.kind === "int"
        ? {
            kind: "int",
            value: operand.value.startsWith("-") ? operand.value.slice(1) : `-${operand.value}`,
          }
        : { kind: "neg", operand };
    }
    if (r.isPunct("+")) r.fail("unary plus");
    if (r.isWord("typeof") || r.isWord("void") || r.isWord("await") || r.isWord("new"))
      r.fail(`the ${r.peek()?.text} operator`);
    return this.postfix(scope, this.primary(scope));
  }

  private postfix(scope: ReadonlyMap<string, SubsetType>, base: Expr): Expr {
    const r: Reader = this.r;
    let e = base;
    for (;;) {
      if (r.isPunct(".")) {
        r.at++;
        const field = r.ident();
        e = { kind: "field", object: e, field };
        continue;
      }
      if (r.isPunct("?.")) r.fail("optional chaining");
      if (r.isPunct("[")) r.fail("index access");
      if (r.isPunct("(")) {
        // A binder or local named like a function shadows it: the call is to a number, which throws.
        if (e.kind === "var" && scope.has(e.name))
          r.fail(`a call to ${e.name}, which names a value here, not the module's function`);
        if (e.kind !== "var" || !this.functions.has(e.name))
          r.fail(
            e.kind !== "var"
              ? "a call to a computed callee"
              : this.declared.has(e.name)
                ? `a call to ${e.name}, which is outside the subset`
                : this.aliases
                  ? `a call to ${e.name}, which is not a function imported from the module beside the spec file`
                  : `a call to ${e.name}, which this module does not declare`,
          );
        r.at++;
        const args: Expr[] = [];
        while (!r.isPunct(")")) {
          args.push(this.expression(scope));
          if (r.isPunct(",")) r.at++;
        }
        r.at++;
        // A spec file's local name for a module function resolves to the function.
        e = { kind: "call", callee: this.aliases?.get(e.name) ?? e.name, args };
        continue;
      }
      if (r.isWord("as") || r.isWord("satisfies")) r.fail(`the ${r.peek()?.text} operator`);
      return e;
    }
  }

  private primary(scope: ReadonlyMap<string, SubsetType>): Expr {
    const r: Reader = this.r;
    const t = r.take();
    switch (t.kind) {
      case "number":
        if (!/^[0-9](_?[0-9])*$/.test(t.text))
          r.fail(`the numeric literal ${t.text} (integers in decimal only)`, t);
        return { kind: "int", value: t.text.replace(/_/g, "") };
      case "string":
        return { kind: "string", value: stringLiteralValue(t.text, r, t) };
      case "template":
        r.fail("a template literal", t);
        break;
      case "regex":
        r.fail("a regular expression", t);
        break;
      case "ident":
        if (t.text === "true" || t.text === "false")
          return { kind: "bool", value: t.text === "true" };
        if (t.text === "null" || t.text === "undefined") r.fail(`${t.text}`, t);
        if (
          t.text === "Number" &&
          !scope.has("Number") &&
          !this.declared.has("Number") &&
          r.isPunct(".") &&
          r.isWord("isInteger", 1) &&
          r.isPunct("(", 2)
        ) {
          r.at += 3;
          const operand = this.expression(scope);
          r.expectPunct(")");
          return { kind: "isInteger", operand };
        }
        if (scope.has(t.text) || this.declared.has(t.text)) return { kind: "var", name: t.text };
        r.fail(
          this.aliases
            ? `${t.text}, which is neither a parameter, a const nor a function imported from the module beside the spec file`
            : `${t.text}, which is neither a parameter, a const nor a function of this module`,
          t,
        );
        break;
      case "punct":
        if (t.text === "(") {
          const e = this.expression(scope);
          r.expectPunct(")");
          return e;
        }
        if (t.text === "{") return this.record(scope);
        if (t.text === "[") r.fail("an array literal", t);
        r.fail(`unexpected ${t.text}`, t);
        break;
      default:
        r.fail(`unexpected ${t.text}`, t);
    }
  }

  private record(scope: ReadonlyMap<string, SubsetType>): Expr {
    const r: Reader = this.r;
    const fields: { name: string; value: Expr }[] = [];
    while (!r.isPunct("}")) {
      if (r.isPunct("...")) r.fail("spread in a record literal");
      if (r.isPunct("[")) r.fail("a computed key");
      const t = r.take();
      if (t.kind !== "ident") r.fail(`a key that is not a name: ${t.text}`, t);
      if (t.text === "__proto__")
        r.fail("a __proto__ key, which sets the prototype, not a field", t);
      if (r.isPunct("(")) r.fail(`a method ${t.text}`, t);
      if (r.isPunct(":")) {
        r.at++;
        fields.push({ name: t.text, value: this.expression(scope) });
      } else {
        if (!scope.has(t.text)) r.fail(`shorthand ${t.text} names nothing in scope`, t);
        fields.push({ name: t.text, value: { kind: "var", name: t.text } });
      }
      if (r.isPunct(",")) r.at++;
    }
    r.at++;
    return { kind: "record", fields };
  }

  typeOfExpr(e: Expr, scope: ReadonlyMap<string, SubsetType>): SubsetType {
    return typeOf(e, scope, { records: this.records, signatures: this.signatures }, (m) =>
      this.r.fail(m),
    );
  }
}

/** A type, for messages. */
function describe(t: SubsetType): string {
  return t.kind === "record" ? t.name : t.kind;
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
): SubsetType {
  switch (e.kind) {
    case "int":
      return { kind: "int" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "var": {
      const t = scope.get(e.name);
      if (!t) fail(`${e.name} is not in scope`);
      return t;
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
      if ((e.op === "===" || e.op === "!==") && JSON.stringify(l) !== JSON.stringify(r))
        fail(`${e.op} between a ${l.kind} and a ${r.kind}`);
      if ((e.op === "===" || e.op === "!==") && l.kind === "record")
        fail(`${e.op} on records compares references in JavaScript; compare their fields instead`);
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
      const a = typeOf(e.ifTrue, scope, ctx, fail);
      const b = typeOf(e.ifFalse, scope, ctx, fail);
      if (JSON.stringify(a) !== JSON.stringify(b))
        fail("the branches of a conditional have different types");
      return a;
    }
    case "let":
      return typeOf(
        e.body,
        new Map([...scope, [e.name, typeOf(e.value, scope, ctx, fail)]]),
        ctx,
        fail,
      );
    case "call": {
      const sig = ctx.signatures.get(e.callee);
      if (!sig) fail(`the signature of ${e.callee} is not known`);
      if (sig.params.length !== e.args.length)
        fail(`${e.callee} takes ${sig.params.length} argument(s), called with ${e.args.length}`);
      e.args.forEach((a, i) => {
        const want = sig.params[i]?.type as SubsetType;
        const got = typeOf(a, scope, ctx, fail);
        if (JSON.stringify(want) !== JSON.stringify(got))
          fail(`argument ${i + 1} of ${e.callee} is a ${got.kind}, not the ${want.kind} it takes`);
      });
      return sig.returns;
    }
    case "field": {
      const o = typeOf(e.object, scope, ctx, fail);
      if (o.kind !== "record") fail(`field ${e.field} read from a ${o.kind}`);
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
      const byNames = [...ctx.records.values()].filter(
        (rec) =>
          rec.fields
            .map((f) => f.name)
            .sort()
            .join(",") === names,
      );
      if (byNames.length === 0)
        fail(`a record literal with fields ${names} matches no declared record type`);
      const types = new Map(e.fields.map((f) => [f.name, typeOf(f.value, scope, ctx, fail)]));
      const fits = byNames.filter((rec) =>
        rec.fields.every((f) => JSON.stringify(types.get(f.name)) === JSON.stringify(f.type)),
      );
      if (fits.length === 0) {
        const rec = byNames[0] as RecordType;
        const off = rec.fields.find(
          (f) => JSON.stringify(types.get(f.name)) !== JSON.stringify(f.type),
        ) as Field;
        fail(
          `field ${off.name} of a ${rec.name} literal holds a ${describe(types.get(off.name) as SubsetType)}, not a ${describe(off.type)}`,
        );
      }
      if (fits.length > 1)
        fail(
          `a record literal with fields ${names} matches ${fits.map((r) => r.name).join(" and ")} alike`,
        );
      return { kind: "record", name: (fits[0] as RecordType).name };
    }
  }
}

/**
 * A parser over text that is not the module: with `aliases`, the text is
 * a spec file's, whose names for the module's functions are its own
 * imports and nothing else; without, the text sees the module's names.
 */
function parserFor(
  text: string,
  module: SubsetModule,
  aliases?: ReadonlyMap<string, string>,
): { r: Reader; parser: FunctionParser } {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (err) {
    if (!(err instanceof TokenizeError)) throw err;
    throw new OutsideSubset(`could not be tokenized: ${err.message}`, 0);
  }
  const r = new Reader(tokens, () => 0);
  const records = new Map(module.records.map((rec) => [rec.name, rec]));
  const inSubset = new Set(module.functions.map((f) => f.name));
  let functions: ReadonlySet<string>;
  let declared: ReadonlySet<string>;
  if (aliases) {
    declared = new Set(aliases.keys());
    functions = new Set([...aliases].filter(([, fn]) => inSubset.has(fn)).map(([local]) => local));
  } else {
    functions = inSubset;
    declared = new Set([...inSubset, ...module.outside.map((o) => o.name)]);
  }
  const parser = new FunctionParser(r, records, functions, new Map(), declared, aliases);
  for (const f of module.functions)
    parser.signatures.set(f.name, { params: f.params, returns: f.returns });
  return { r, parser };
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
  const { r, parser } = parserFor(text, module, aliases);
  const e = parser.expression(scope);
  if (r.at < r.tokens.length) r.fail(`unexpected ${r.peek()?.text} after the expression`);
  return e;
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
  if (!arrow.block) return readExpression(arrow.body, scope, module, aliases);
  const { r, parser } = parserFor(`${arrow.body}}`, module, aliases);
  const e = parser.blockBody(new Map(scope), { kind: "bool" });
  if (r.at < r.tokens.length) r.fail(`unexpected ${r.peek()?.text} after the block`);
  return e;
}

/** Every name an expression binds or refers to: its variables and its lets. */
function boundNames(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
      return out;
    case "var":
      out.add(e.name);
      return out;
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
): Expr {
  const go = (x: Expr): Expr => renameVars(x, names, taken);
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
      return e;
    case "var":
      return { kind: "var", name: names.get(e.name) ?? e.name };
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
      return {
        kind: "record",
        fields: e.fields.map((f) => ({ name: f.name, value: go(f.value) })),
      };
    case "let": {
      // A let binds its own name; a binder of that name is shadowed inside, as in the source.
      const inner = new Map(names);
      inner.delete(e.name);
      let bound = e.name;
      const targets = new Set(names.values());
      if (targets.has(e.name)) {
        // The let would capture a renamed reference: the let itself moves out of the way, to a name
        // nothing in the expression uses (another let may already be spelled with the underscore).
        bound = fresh(e.name, taken);
        inner.set(e.name, bound);
      }
      return {
        kind: "let",
        name: bound,
        value: go(e.value),
        body: renameVars(e.body, inner, new Set([...taken, bound])),
      };
    }
  }
}

/** The functions an expression calls. */
function callees(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "var":
      return out;
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
  }
}

/**
 * Read a module: its record types, every function the subset takes (in
 * source order, so callees come before callers) and, for the others, why
 * not. A function calling one outside the subset is outside it too. The
 * names given are what the caller cares about; one the module does not
 * declare at its top level is reported among the others, not thrown.
 */
export function readSubset(source: string, functions?: readonly string[]): SubsetModule {
  // Every JavaScript line terminator counts (LF, CR, CRLF as one, U+2028, U+2029): a return
  // followed by any of them returns undefined.
  const lineOf = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      const c = source[i];
      if (c === "\r") {
        line++;
        if (source[i + 1] === "\n") i++;
      } else if (c === "\n" || c === "\u2028" || c === "\u2029") line++;
    }
    return line;
  };
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    // Source the scanner cannot read is source the reader cannot trust: every name asked for is outside.
    if (!(err instanceof TokenizeError)) throw err;
    return {
      records: [],
      functions: [],
      outside: (functions ?? []).map((name) => ({
        name,
        line: 0,
        message: `the module could not be tokenized: ${err.message}`,
      })),
    };
  }
  const r = new Reader(tokens, lineOf);
  // Pass 1: record types, and where every function declaration starts.
  const records = new Map<string, RecordType>();
  const badRecords = new Map<string, string>();
  const declared = new Set<string>();
  const assigned = new Map<string, number>();
  const starts: number[] = [];
  while (r.at < tokens.length) {
    const t = r.peek() as Token;
    if (t.kind === "ident" && t.text === "import") {
      // An import (type-only or not) declares nothing the subset reads.
      r.at++;
      skipDeclaration(r);
      continue;
    }
    if (
      t.kind === "ident" &&
      (t.text === "interface" || t.text === "type" || t.text === "export")
    ) {
      const save = r.at;
      try {
        const rec = recordAt(r, new Set(records.keys()));
        if (rec) {
          records.set(rec.name, rec);
          continue;
        }
      } catch (err) {
        // A record type the subset does not take: noted, so a function using it says why, and skipped.
        if (!(err instanceof OutsideSubset)) throw err;
        r.at = save;
        if (r.isWord("export")) r.at++;
        r.at++;
        // `export type { A }` and friends name no record; a named one is noted so its users say why.
        if (r.peek()?.kind === "ident") badRecords.set(r.ident(), err.message);
        skipDeclaration(r);
        continue;
      }
      r.at = save;
    }
    if (t.kind === "ident" && t.text === "function" && isDeclaration(tokens, r.at, lineOf)) {
      // `function* f` is a generator: its name is recorded so the signature pass can refuse it by name.
      const name = r.isPunct("*", 1) ? r.peek(2) : r.peek(1);
      if (name?.kind === "ident") declared.add(name.text);
      // The declaration starts at its modifiers, which the second pass reads (and refuses, for async).
      let start = r.at;
      if (r.isWord("async", start - r.at - 1)) start--;
      if (r.isWord("export", start - r.at - 1)) start--;
      starts.push(start);
      r.at++;
      continue;
    }
    if (t.kind === "punct" && ["(", "[", "{"].includes(t.text)) {
      skipGroup(r);
      continue;
    }
    r.at++;
  }
  // A declared function used as a value anywhere in the module (assigned to, aliased, passed on) may not
  // be what its declaration says when called; such a function, and its callers, are outside.
  for (const [name, line] of valueUses(tokens, lineOf)) assigned.set(name, line);
  const outside = new Map<string, OutsideFunction>();
  // A name asked for that is no module-level declaration (inside a namespace, say) is reported, not thrown.
  for (const name of functions ?? [])
    if (!declared.has(name))
      outside.set(name, {
        name,
        line: 0,
        message: `the module declares no function ${name} at its top level`,
      });
  // A direct eval can rebind any declaration of the module without naming it, so any mention of `eval`
  // that is not a property of something else (`globalThis.eval` is indirect, and cannot) puts the whole
  // module outside: `eval(…)`, `(eval)(…)`, inside a template substitution alike.
  const evalLine = mentionsEval(tokens, lineOf);
  if (evalLine !== undefined)
    for (const name of declared)
      outside.set(name, {
        name,
        line: evalLine,
        message: "the module mentions eval directly, which can rebind any of its declarations",
      });
  // An identifier escape (`\u0066` for `f`) spells a name the scans above cannot match: nothing is trusted.
  const escapeLine = firstLine(tokens, lineOf, (t) => t.kind === "punct" && t.text === "\\");
  if (escapeLine !== undefined)
    for (const name of declared)
      if (!outside.has(name))
        outside.set(name, {
          name,
          line: escapeLine,
          message:
            "the module uses an identifier escape sequence (\\u…), so its names cannot be matched by spelling",
        });
  for (const [name, line] of assigned)
    if (declared.has(name) && !outside.has(name))
      outside.set(name, {
        name,
        line,
        message: `${name} is used as a value in the module (not only called), so what runs under its name may not be its declaration`,
      });
  // Pass 2: signatures, so every function's return type is known before any body is read.
  const parser = new FunctionParser(r, records, declared, badRecords);
  const signatures: Signature[] = [];
  for (const start of starts) {
    r.at = start;
    try {
      const sig = parser.signature();
      // Callers of a reassigned function still type-check against its declaration; they are then outside with it.
      parser.signatures.set(sig.name, { params: sig.params, returns: sig.returns });
      if (!outside.has(sig.name)) signatures.push(sig);
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      // The name after `function`, past a generator's `*`.
      const head = tokens.slice(start, start + 5);
      const fnAt = head.findIndex((t) => t.kind === "ident" && t.text === "function");
      const after = head[fnAt + 1]?.text === "*" ? head[fnAt + 2] : head[fnAt + 1];
      const name = after?.kind === "ident" ? after.text : undefined;
      if (name) outside.set(name, { name, line: err.line, message: err.message });
    }
  }
  // Pass 3: bodies.
  const read = new Map<string, SubsetFunction>();
  for (const sig of signatures) {
    try {
      read.set(sig.name, parser.declaration(sig));
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      outside.set(sig.name, { name: sig.name, line: err.line, message: err.message });
    }
  }
  // A caller of a function outside the subset is outside it too, however many steps away.
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
  // Recursion is not in the subset yet: a function reaching itself through its callees is outside, and so are its callers.
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
      read.delete(name);
      outside.set(name, {
        name,
        line: fn.line,
        message: `${name} is recursive (it reaches itself through its calls); recursion is not in the subset yet`,
      });
    }
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
  // Callees before callers, whatever the source order: Lean needs a definition before its use.
  const ordered: SubsetFunction[] = [];
  const placed = new Set<string>();
  while (ordered.length < read.size)
    for (const [name, fn] of read)
      if (!placed.has(name) && [...callees(fn.body)].every((c) => placed.has(c))) {
        ordered.push(fn);
        placed.add(name);
      }
  return { records: [...records.values()], functions: ordered, outside: [...outside.values()] };
}
