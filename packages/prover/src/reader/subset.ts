/**
 * The pure TypeScript subset the first-party engines accept, read into a
 * small tree: exported functions over `number`, `boolean` and `string`,
 * the module's own record types, nullable types (`T | null`) and tagged
 * unions of records declared as type aliases, returning any of those;
 * bodies made of `const` bindings, `if` with early returns, `return`, and
 * expressions from arithmetic (`+ - *`), comparisons, `=== !==` (`null`
 * included, which narrows a nullable name in the branch it guards),
 * `&& || !`, the conditional operator, record literals, field reads (on
 * a union, only a field every member has) and calls to the module's own
 * functions. Anything else is `OutsideSubset`, with the construct named:
 * the subset is specified by the contract corpus and widens one
 * characterised class at a time. What each engine takes of it is the
 * engine's business (`restrictModule`).
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
  | { readonly kind: "record"; readonly name: string }
  /** `T | null`. */
  | { readonly kind: "nullable"; readonly inner: SubsetType }
  /** A tagged union of records declared as a type alias; its members are records of the module. */
  | { readonly kind: "union"; readonly name: string }
  /** The type of the literal `null` itself, which only a nullable type accepts. */
  | { readonly kind: "null" };

export interface Field {
  readonly name: string;
  readonly type: SubsetType;
  /** The one value a literal-typed field holds (`ok: true`, `type: "locked"`): a union member's tag. */
  readonly literal?: string | boolean;
}

export interface RecordType {
  readonly name: string;
  readonly fields: readonly Field[];
  /** The tagged union this record is a member of, when it is one; its name is then `<union>.<tag>`. */
  readonly union?: string;
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
  | {
      readonly kind: "let";
      readonly name: string;
      readonly value: Expr;
      readonly body: Expr;
      /** The `const`'s annotation, when it has one: the binding's type, whatever the initializer's. */
      readonly type?: SubsetType;
    };

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
  readonly unions: readonly UnionType[];
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

/** The module's declared types, as the reader resolves names. */
export interface Declared {
  readonly records: ReadonlySet<string>;
  /** The records themselves, for a union naming its members. */
  readonly recordsByName?: ReadonlyMap<string, RecordType>;
  /** Type aliases to a type the subset reads (`type Status = "a" | "b"`, `type Maybe = T | null`) and the unions by name. */
  readonly aliases: ReadonlyMap<string, SubsetType>;
}

/** One alternative of a type expression, before the union is classified. */
type Alternative =
  | { readonly kind: "type"; readonly type: SubsetType; readonly token: Token }
  | { readonly kind: "literal"; readonly value: string | boolean; readonly token: Token }
  | { readonly kind: "null"; readonly token: Token };

/** A type annotation: one alternative, or a union of them, read in full. */
function typeAnnotation(r: Reader, declared: Declared, bad: BadRecords = new Map()): SubsetType {
  const first = r.peek();
  const alternatives: Alternative[] = [];
  if (r.isPunct("|")) r.at++;
  for (;;) {
    alternatives.push(alternative(r, declared, bad));
    if (!r.isPunct("|")) break;
    r.at++;
  }
  if (r.isPunct("[") || r.isPunct("<") || r.isPunct("&"))
    r.fail(`type …${r.peek()?.text}… (arrays, generics and intersections are outside the subset)`);
  return classify(alternatives, r, first);
}

function alternative(r: Reader, declared: Declared, bad: BadRecords): Alternative {
  const t = r.take();
  if (t.kind === "string")
    return { kind: "literal", value: stringLiteralValue(t.text, r, t), token: t };
  if (t.kind !== "ident") r.fail(`a type that is not a name: ${t.text}`, t);
  if (t.text === "null") return { kind: "null", token: t };
  if (t.text === "true" || t.text === "false")
    return { kind: "literal", value: t.text === "true", token: t };
  if (t.text === "undefined") r.fail("undefined in a type (the subset has null)", t);
  const why = bad.get(t.text);
  if (why !== undefined) r.fail(`type ${t.text} is outside the subset: ${why}`, t);
  if (t.text === "number") return { kind: "type", type: { kind: "int" }, token: t };
  if (t.text === "boolean") return { kind: "type", type: { kind: "bool" }, token: t };
  if (t.text === "string") return { kind: "type", type: { kind: "string" }, token: t };
  if (declared.records.has(t.text))
    return { kind: "type", type: { kind: "record", name: t.text }, token: t };
  const alias = declared.aliases.get(t.text);
  if (alias) return { kind: "type", type: alias, token: t };
  r.fail(
    `type ${t.text} (the subset has number, boolean, string, null, and the module's own record types, unions and aliases)`,
    t,
  );
}

/**
 * The type a list of alternatives names: a single type; string literals as
 * `string` (the proof covers every string, more than the type admits);
 * either with `null` as nullable. Several records are a tagged union only
 * when declared as an alias, where `unionAt` classifies them.
 */
function classify(
  alternatives: readonly Alternative[],
  r: Reader,
  at: Token | undefined,
): SubsetType {
  const nulls = alternatives.filter((a) => a.kind === "null");
  const literals = alternatives.filter(
    (a): a is Extract<Alternative, { kind: "literal" }> => a.kind === "literal",
  );
  const types = alternatives.filter(
    (a): a is Extract<Alternative, { kind: "type" }> => a.kind === "type",
  );
  let base: SubsetType | undefined;
  if (literals.length > 0 && types.length === 0) {
    const kinds = new Set(literals.map((l) => typeof l.value));
    if (kinds.size > 1) r.fail("a union mixing string and boolean literals", at);
    base =
      literals[0]?.value === true || literals[0]?.value === false
        ? { kind: "bool" }
        : { kind: "string" };
  } else if (types.length === 1 && literals.length === 0)
    base = (types[0] as (typeof types)[number]).type;
  else if (types.length === 0 && literals.length === 0)
    r.fail("null alone is not a type the subset takes", at);
  else
    r.fail(
      "a union of several types (a tagged union of records is read only where it is declared as a type alias)",
      at,
    );
  if (!base) r.fail("an empty type", at);
  if (base.kind === "nullable" && nulls.length > 0) return base;
  if (base.kind === "null") r.fail("null alone is not a type the subset takes", at);
  return nulls.length > 0 ? { kind: "nullable", inner: base } : base;
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

/** The fields of the `{ … }` at the reader; a literal-typed field keeps its literal. */
function fieldsAt(r: Reader, declared: Declared): Field[] {
  r.expectPunct("{");
  const fields: Field[] = [];
  while (!r.isPunct("}")) {
    if (r.isWord("readonly")) r.at++;
    const fname = r.ident();
    if (r.isPunct("?")) r.fail(`optional field ${fname}`);
    if (structureNames.has(fname)) r.fail(`field ${fname} takes a name Lean's structures reserve`);
    if (fname === "__proto__") r.fail("a field named __proto__, which JavaScript treats specially");
    r.expectPunct(":");
    const literalToken = r.peek();
    const type = typeAnnotation(r, declared);
    // One literal alone (`ok: true`, `type: "locked"`): a tag; a union of literals is its base type.
    const alone = r.peek(-1) === literalToken;
    const literal = !alone
      ? undefined
      : literalToken?.kind === "string" && type.kind === "string"
        ? stringLiteralValue(literalToken.text, r, literalToken)
        : literalToken?.kind === "ident" &&
            (literalToken.text === "true" || literalToken.text === "false") &&
            type.kind === "bool"
          ? literalToken.text === "true"
          : undefined;
    fields.push({ name: fname, type, ...(literal === undefined ? {} : { literal }) });
    if (r.isPunct(";") || r.isPunct(",")) r.at++;
  }
  r.expectPunct("}");
  return fields;
}

/** What a type declaration at the reader declares. */
export type Declaration =
  | { readonly kind: "record"; readonly record: RecordType }
  | { readonly kind: "alias"; readonly name: string; readonly type: SubsetType }
  | {
      readonly kind: "union";
      readonly union: UnionType;
      readonly members: readonly RecordType[];
    };

/**
 * `interface Name { … }`, `type Name = { … }`, `type Name = <type>` or
 * `type Name = A | B | { … }` at the reader, after any `export`. A union of
 * records needs a tag: a field every member has, literal-typed, with a
 * different literal in each.
 */
function declarationAt(r: Reader, declared: Declared): Declaration | undefined {
  const start = r.at;
  if (r.isWord("export")) r.at++;
  const alias = r.isWord("type");
  if (!r.isWord("interface") && !alias) {
    r.at = start;
    return undefined;
  }
  r.at++;
  const name = r.ident();
  if (r.isPunct("<")) r.fail("type parameters on a type declaration", r.peek());
  if (!alias) {
    if (r.isWord("extends")) r.fail("interface inheritance", r.peek());
    const fields = fieldsAt(r, declared);
    if (r.isPunct(";")) r.at++;
    return { kind: "record", record: { name, fields } };
  }
  r.expectPunct("=");
  if (r.isPunct("|")) r.at++;
  // Alternatives: inline records, declared records, literals, null; a tagged union when several are records.
  const inline: RecordType[] = [];
  const named: string[] = [];
  const others: Alternative[] = [];
  const at = r.peek();
  for (;;) {
    if (r.isPunct("{"))
      inline.push({
        name: `${name}.${inline.length + named.length}`,
        fields: fieldsAt(r, declared),
      });
    else {
      const a = alternative(r, declared, new Map());
      if (a.kind === "type" && a.type.kind === "record") named.push(a.type.name);
      else others.push(a);
    }
    if (!r.isPunct("|")) break;
    r.at++;
  }
  if (r.isPunct(";")) r.at++;
  const recordCount = inline.length + named.length;
  if (recordCount === 0) return { kind: "alias", name, type: classify(others, r, at) };
  if (others.some((o) => o.kind !== "null")) r.fail("a union mixing records with other types", at);
  if (recordCount === 1 && inline.length === 1) {
    const only = inline[0] as RecordType;
    if (others.length > 0)
      r.fail(
        `${name}: a nullable record type is written on the parameter, not declared as an alias`,
        at,
      );
    return { kind: "record", record: { name, fields: only.fields } };
  }
  if (recordCount === 1) {
    const type: SubsetType = { kind: "record", name: named[0] as string };
    return {
      kind: "alias",
      name,
      type: others.length > 0 ? { kind: "nullable", inner: type } : type,
    };
  }
  if (others.length > 0)
    r.fail(
      `${name}: a union of records with null is written as the union, then | null, on the parameter`,
      at,
    );
  // Named members are the module's records as they are; inline members become records of the union.
  const memberRecords: RecordType[] = [...inline];
  const memberNames = [...inline.map((m) => m.name), ...named];
  const lookup = (n: string): RecordType | undefined =>
    memberRecords.find((m) => m.name === n) ?? declared.recordsByName?.get(n);
  const first = lookup(memberNames[0] as string);
  if (!first) r.fail(`${name}: member ${memberNames[0]} is not a record the subset read`, at);
  const tags = first.fields
    .filter((f) => f.literal !== undefined)
    .map((f) => f.name)
    .filter((tag) =>
      memberNames.every((m) => {
        const rec = lookup(m);
        return rec?.fields.some((f) => f.name === tag && f.literal !== undefined);
      }),
    )
    .filter((tag) => {
      const values = memberNames.map((m) => lookup(m)?.fields.find((f) => f.name === tag)?.literal);
      return new Set(values.map((v) => JSON.stringify(v))).size === values.length;
    });
  const tag = tags[0];
  if (tag === undefined)
    r.fail(
      `${name}: a union of records without a tag (a literal-typed field every member has, different in each)`,
      at,
    );
  const members = memberNames.map((m) => {
    const rec = lookup(m) as RecordType;
    const value = rec.fields.find((f) => f.name === tag)?.literal as string | boolean;
    return { tag: value, record: m };
  });
  // Inline members are named by their tag, so the constructor names read: `Outcome.true`, `Refused.locked`.
  const renamed = new Map(
    inline.map((m, i) => [
      m.name,
      `${name}.${String((members[i] as (typeof members)[number]).tag)}`,
    ]),
  );
  const finalMembers = members.map((m) => ({ ...m, record: renamed.get(m.record) ?? m.record }));
  const finalRecords = inline.map((m) => ({
    ...m,
    name: renamed.get(m.name) as string,
    union: name,
  }));
  return { kind: "union", union: { name, tag, members: finalMembers }, members: finalRecords };
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
    // An object key, or a type's member (`readonly attempts: number;`), is no use of a value.
    if (
      isPunct(after, ":") &&
      (isPunct(before, "{") ||
        isPunct(before, ",") ||
        isPunct(before, ";") ||
        (before?.kind === "ident" && before.text === "readonly"))
    )
      return;
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
  /** The module's type aliases and unions, by name. */
  private readonly typeAliases: ReadonlyMap<string, SubsetType>;
  readonly signatures = new Map<string, CalleeSignature>();
  constructor(
    r: Reader,
    records: ReadonlyMap<string, RecordType>,
    functions: ReadonlySet<string>,
    badRecords: BadRecords = new Map(),
    declared: ReadonlySet<string> = functions,
    aliases?: ReadonlyMap<string, string>,
    typeAliases: ReadonlyMap<string, SubsetType> = new Map(),
  ) {
    this.r = r;
    this.records = records;
    this.functions = functions;
    this.badRecords = badRecords;
    this.declared = declared;
    this.aliases = aliases;
    this.typeAliases = typeAliases;
  }

  private get types(): Declared {
    return {
      records: new Set(this.records.keys()),
      recordsByName: this.records,
      aliases: this.typeAliases,
    };
  }

  private get ctx(): TypeContext {
    return { records: this.records, signatures: this.signatures };
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
      const type = typeAnnotation(r, this.types, this.badRecords);
      if (r.isPunct("=")) r.fail(`a default value for ${pname}`);
      params.push({ name: pname, type });
      if (r.isPunct(",")) r.at++;
    }
    r.expectPunct(")");
    if (!r.isPunct(":"))
      r.fail(`${name} without a return type (the subset needs it to name the record returned)`);
    r.at++;
    const returns = typeAnnotation(r, this.types, this.badRecords);
    r.expectPunct("{");
    return { name, params, returns, line, offset, body: r.at };
  }

  /** The function, its body read from where the signature stopped. */
  declaration(sig: Signature): SubsetFunction {
    this.r.at = sig.body;
    const scope = new Map(sig.params.map((p) => [p.name, p.type]));
    // Null checks narrow the names they guard in the branches they guard, before anything is typed.
    const body = this.narrowed(this.block(scope, sig.returns), scope);
    // Typing the whole body here: a record literal of no declared type, a field read on an integer or
    // a body of another type than declared are all outside the subset, found now rather than by an engine.
    const actual = this.typeOfExpr(body, scope);
    if (!fits(actual, sig.returns, this.ctx))
      this.r.fail(
        `${sig.name} returns a ${describe(actual)} but declares ${describe(sig.returns)}`,
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

  /** The expression with `narrow` nodes inserted where a null check guards a nullable name. */
  narrowed(e: Expr, scope: ReadonlyMap<string, SubsetType>): Expr {
    return insertNarrows(e, scope, this.ctx, (m) => this.r.fail(m));
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
        annotated = typeAnnotation(r, this.types, this.badRecords);
      }
      r.expectPunct("=");
      const value = this.expression(scope);
      if (r.isPunct(";")) r.at++;
      // While parsing, the scope carries names; types come from `typeOf` once null checks have narrowed
      // the tree, so an initializer under a guard is typed as the guard allows. The annotation is the
      // binding's type (a null initializer is then a nullable, not null); `typeOf` checks it fits.
      const inner = new Map(scope);
      inner.set(name, annotated ?? { kind: "null" });
      const body = this.block(inner, returns);
      return { kind: "let", name, value, body, ...(annotated ? { type: annotated } : {}) };
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
        if (t.text === "null") return { kind: "null" };
        if (t.text === "undefined") r.fail("undefined (the subset has null)", t);
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
    return typeOf(e, scope, this.ctx, (m) => this.r.fail(m));
  }
}

/** A type, for messages. */
export function describe(t: SubsetType): string {
  switch (t.kind) {
    case "record":
    case "union":
      return t.name;
    case "nullable":
      return `${describe(t.inner)} | null`;
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
  if (expected.kind === "union")
    return actual.kind === "record" && ctx.records.get(actual.name)?.union === expected.name;
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
  if (a.kind === "record" && b.kind === "record") {
    const ua = ctx.records.get(a.name)?.union;
    if (ua !== undefined && ua === ctx.records.get(b.name)?.union)
      return { kind: "union", name: ua };
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

const isReference = (t: SubsetType): boolean => t.kind === "record" || t.kind === "union";

/**
 * The names a test, holding or failing, shows to be non-null: `x !== null`
 * holding, `x === null` failing, through `!`, `&&` (holding) and `||`
 * (failing).
 */
export function narrowsOf(test: Expr, holds: boolean): string[] {
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
 * `narrow` nodes inserted where a null check guards: in a conditional's
 * branches, and in the right operand of `&&` and `||`, for each nullable
 * name the test shows to be non-null there.
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
    names: readonly string[],
    sc: ReadonlyMap<string, SubsetType>,
  ): Expr => {
    const inner = new Map(sc);
    let out = body;
    const nullable = [...new Set(names)].filter((n) => sc.get(n)?.kind === "nullable");
    for (const n of nullable) inner.set(n, (sc.get(n) as { inner: SubsetType }).inner);
    out = go(out, inner);
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
      return e;
    case "binary": {
      const left = go(e.left, scope);
      if (e.op === "&&")
        return {
          kind: "binary",
          op: e.op,
          left,
          right: wrap(e.right, narrowsOf(left, true), scope),
        };
      if (e.op === "||")
        return {
          kind: "binary",
          op: e.op,
          left,
          right: wrap(e.right, narrowsOf(left, false), scope),
        };
      return { kind: "binary", op: e.op, left, right: go(e.right, scope) };
    }
    case "cond": {
      const test = go(e.test, scope);
      return {
        kind: "cond",
        test,
        ifTrue: wrap(e.ifTrue, narrowsOf(test, true), scope),
        ifFalse: wrap(e.ifFalse, narrowsOf(test, false), scope),
      };
    }
    case "call":
      return { kind: "call", callee: e.callee, args: e.args.map((a) => go(a, scope)) };
    case "field":
      return { kind: "field", object: go(e.object, scope), field: e.field };
    case "record":
      return {
        kind: "record",
        fields: e.fields.map((f) => ({ name: f.name, value: go(f.value, scope) })),
      };
    case "let": {
      const value = go(e.value, scope);
      const inner = new Map(scope);
      inner.set(e.name, e.type ?? typeOf(value, scope, ctx, fail));
      return { ...e, value, body: go(e.body, inner) };
    }
  }
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
      return typeOf(e.body, new Map([...scope, [e.name, t.inner]]), ctx, fail);
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
      const a = typeOf(e.ifTrue, scope, ctx, fail);
      const b = typeOf(e.ifFalse, scope, ctx, fail);
      const joined = join(a, b, ctx);
      if (!joined)
        fail(
          `the branches of a conditional have different types (${describe(a)} and ${describe(b)})`,
        );
      return joined;
    }
    case "let": {
      const inferred = typeOf(e.value, scope, ctx, fail);
      if (e.type && !fits(inferred, e.type, ctx))
        fail(`const ${e.name} is annotated ${describe(e.type)} but holds a ${describe(inferred)}`);
      return typeOf(e.body, new Map([...scope, [e.name, e.type ?? inferred]]), ctx, fail);
    }
    case "call": {
      const sig = ctx.signatures.get(e.callee);
      if (!sig) fail(`the signature of ${e.callee} is not known`);
      if (sig.params.length !== e.args.length)
        fail(`${e.callee} takes ${sig.params.length} argument(s), called with ${e.args.length}`);
      e.args.forEach((a, i) => {
        const want = sig.params[i]?.type as SubsetType;
        const got = typeOf(a, scope, ctx, fail);
        if (!fits(got, want, ctx))
          fail(
            `argument ${i + 1} of ${e.callee} is a ${describe(got)}, not the ${describe(want)} it takes`,
          );
      });
      return sig.returns;
    }
    case "field": {
      const o = typeOf(e.object, scope, ctx, fail);
      if (o.kind === "nullable")
        fail(
          `field ${e.field} read from a ${describe(o)}: compare it with null first, which narrows it`,
        );
      if (o.kind === "union") {
        // Only a field every member has, with one type: the tag, typically. Narrowing by the tag is not in the subset yet.
        const members = [...ctx.records.values()].filter((rec) => rec.union === o.name);
        const types = members.map((rec) => rec.fields.find((x) => x.name === e.field)?.type);
        if (types.some((t) => t === undefined))
          fail(
            `field ${e.field} is not on every member of ${o.name} (narrowing by the tag is not in the subset yet)`,
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
  const typeAliases = new Map<string, SubsetType>(
    module.unions.map((u) => [u.name, { kind: "union", name: u.name }]),
  );
  const parser = new FunctionParser(
    r,
    records,
    functions,
    new Map(),
    declared,
    aliases,
    typeAliases,
  );
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
  if (!arrow.block) {
    const { r, parser } = parserFor(arrow.body, module, aliases);
    const e = parser.expression(scope);
    if (r.at < r.tokens.length) r.fail(`unexpected ${r.peek()?.text} after the expression`);
    return parser.narrowed(e, scope);
  }
  const { r, parser } = parserFor(`${arrow.body}}`, module, aliases);
  const e = parser.blockBody(new Map(scope), { kind: "bool" });
  if (r.at < r.tokens.length) r.fail(`unexpected ${r.peek()?.text} after the block`);
  return parser.narrowed(e, scope);
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
    case "null":
      return e;
    case "var":
      return { kind: "var", name: names.get(e.name) ?? e.name };
    case "narrow":
      return { kind: "narrow", name: names.get(e.name) ?? e.name, body: go(e.body) };
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
        ...e,
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
    case "null":
    case "var":
      return out;
    case "narrow":
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
      unions: [],
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
  const unions: UnionType[] = [];
  const typeAliases = new Map<string, SubsetType>();
  const declaredTypes = (): Declared => ({
    records: new Set(records.keys()),
    recordsByName: records,
    aliases: typeAliases,
  });
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
        const decl = declarationAt(r, declaredTypes());
        if (decl) {
          if (decl.kind === "record") records.set(decl.record.name, decl.record);
          else if (decl.kind === "alias") typeAliases.set(decl.name, decl.type);
          else {
            for (const m of decl.members) records.set(m.name, m);
            // A named member is the module's own record, now also a member of the union.
            for (const m of decl.union.members) {
              const rec = records.get(m.record);
              if (rec && rec.union === undefined)
                records.set(m.record, { ...rec, union: decl.union.name });
              else if (rec && rec.union !== decl.union.name)
                // One datatype per record: a record in two unions would need two constructors.
                badRecords.set(
                  decl.union.name,
                  `${m.record} is already a member of ${rec.union}; a record belongs to one union`,
                );
            }
            if (!badRecords.has(decl.union.name)) {
              unions.push(decl.union);
              typeAliases.set(decl.union.name, { kind: "union", name: decl.union.name });
            }
          }
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
  const parser = new FunctionParser(
    r,
    records,
    declared,
    badRecords,
    declared,
    undefined,
    typeAliases,
  );
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
  return {
    records: [...records.values()],
    unions,
    functions: ordered,
    outside: [...outside.values()],
  };
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
): SubsetModule {
  const badRecords = new Set<string>();
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
  }
  const outside = new Map(module.outside.map((o) => [o.name, o]));
  const kept = new Map(module.functions.map((f) => [f.name, f]));
  const uses = (f: SubsetFunction) =>
    !f.params.every((p) => typeTaken(p.type, takes, badRecords)) ||
    !typeTaken(f.returns, takes, badRecords) ||
    hasNode(f.body, new Set(["null", "narrow"]));
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
    records: module.records.filter((r) => !badRecords.has(r.name)),
    unions: module.unions.filter((u) => takes({ kind: "union", name: u.name })),
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
  if (t.kind === "nullable") return typeTaken(t.inner, takes, badRecords);
  return true;
}
