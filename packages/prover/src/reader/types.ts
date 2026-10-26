/**
 * TypeScript type syntax read into `SpecType`: the primitives, literals,
 * `null` and `undefined`, type literals and the module's own `interface`
 * and `type` declarations (type parameters substituted), and unions of
 * them. What the reader cannot read (arrays, intersections, imported
 * types, methods, index signatures, optional fields, recursion) becomes
 * `unknown` with its text, never a guess: a binder of unknown type is still
 * checked on the inputs the simulator passed, only not drawn or proved.
 */

import type { Field, SpecType } from "@eutaxy/spec";
import type { Token } from "./tokens.ts";

/** An `interface` or `type` declaration at the module's top level. */
export interface TypeDeclaration {
  readonly name: string;
  readonly params: readonly string[];
  /** The tokens of the type: the `{ … }` of an interface, the right-hand side of an alias. */
  readonly tokens: readonly Token[];
  /** Set when the declaration is one the reader does not read (`extends`, say). */
  readonly unsupported?: string;
}

const isPunct = (t: Token | undefined, text: string): boolean =>
  t?.kind === "punct" && t.text === text;
const isWord = (t: Token | undefined, text: string): boolean =>
  t?.kind === "ident" && t.text === text;

const opens = new Set(["(", "[", "{"]);
const closes = new Set([")", "]", "}"]);

/** The index just past the group opened at `i`. */
function skipGroup(tokens: readonly Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.kind !== "punct") continue;
    if (opens.has(t.text)) depth++;
    else if (closes.has(t.text)) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

/** The index just past the `>` closing the type arguments opened at `i`. */
function skipAngles(tokens: readonly Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.kind !== "punct") continue;
    if (t.text === "<") depth++;
    else if (/^>+$/.test(t.text)) {
      depth -= t.text.length;
      if (depth <= 0) return j + 1;
    } else if (opens.has(t.text)) j = skipGroup(tokens, j) - 1;
  }
  return tokens.length;
}

/** Type parameter names of the list opened at `i` (`<T, E extends X = Y>`), and the index past it. */
function typeParams(tokens: readonly Token[], i: number): { names: string[]; end: number } {
  const names: string[] = [];
  const end = skipAngles(tokens, i);
  let expectName = true;
  let depth = 0;
  for (let j = i + 1; j < end - 1; j++) {
    const t = tokens[j] as Token;
    if (t.kind === "punct") {
      if (t.text === "<" || opens.has(t.text)) depth++;
      else if (/^>+$/.test(t.text) || closes.has(t.text)) depth--;
      else if (t.text === "," && depth === 0) expectName = true;
      continue;
    }
    if (expectName && depth === 0 && t.kind === "ident") names.push(t.text);
    expectName = false;
  }
  return { names, end };
}

const declarationStarts = new Set(
  "export import function interface type const let var class enum declare async abstract namespace module".split(
    " ",
  ),
);

/**
 * The module's top-level type declarations. An alias runs to its `;`, or
 * to the next declaration keyword on a later line (automatic semicolon
 * insertion); groups are skipped whole.
 */
export function typeDeclarations(
  tokens: readonly Token[],
  lineOf: (offset: number) => number,
): Map<string, TypeDeclaration> {
  const out = new Map<string, TypeDeclaration>();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && opens.has(t.text)) {
      i = skipGroup(tokens, i);
      continue;
    }
    if (t.kind !== "ident" || (t.text !== "interface" && t.text !== "type")) {
      i++;
      continue;
    }
    // `type` is a declaration only when a name and `=` (or `<`) follow; `interface` likewise with `{`.
    const name = tokens[i + 1];
    if (name?.kind !== "ident") {
      i++;
      continue;
    }
    let j = i + 2;
    let params: string[] = [];
    if (isPunct(tokens[j], "<")) {
      const p = typeParams(tokens, j);
      params = p.names;
      j = p.end;
    }
    if (t.text === "interface") {
      if (isWord(tokens[j], "extends")) {
        // To the body, then past it.
        while (j < tokens.length && !isPunct(tokens[j], "{")) j++;
        const end = skipGroup(tokens, j);
        out.set(name.text, {
          name: name.text,
          params,
          tokens: tokens.slice(j, end),
          unsupported: "interface inheritance",
        });
        i = end;
        continue;
      }
      if (!isPunct(tokens[j], "{")) {
        i++;
        continue;
      }
      const end = skipGroup(tokens, j);
      out.set(name.text, { name: name.text, params, tokens: tokens.slice(j, end) });
      i = end;
      continue;
    }
    if (!isPunct(tokens[j], "=")) {
      i++;
      continue;
    }
    const start = j + 1;
    let end = start;
    let depth = 0;
    while (end < tokens.length) {
      const u = tokens[end] as Token;
      if (u.kind === "punct") {
        if (opens.has(u.text) || u.text === "<") depth++;
        else if (closes.has(u.text)) depth--;
        else if (/^>+$/.test(u.text)) depth -= u.text.length;
        else if (u.text === ";" && depth === 0) break;
      } else if (
        depth === 0 &&
        u.kind === "ident" &&
        declarationStarts.has(u.text) &&
        end > start &&
        lineOf(u.start) > lineOf((tokens[end - 1] as Token).end)
      )
        break;
      end++;
    }
    out.set(name.text, { name: name.text, params, tokens: tokens.slice(start, end) });
    i = end;
  }
  return out;
}

export interface TypeEnv {
  readonly source: string;
  readonly declarations: ReadonlyMap<string, TypeDeclaration>;
  /** Type parameters in scope, bound to their arguments. */
  readonly bindings: ReadonlyMap<string, SpecType>;
  /** Declarations being expanded, against recursion. */
  readonly expanding: ReadonlySet<string>;
}

const unknown = (text: string): SpecType => ({ kind: "unknown", text: text.trim() });

/** The source text spanned by the tokens, for an `unknown`. */
function textOf(source: string, tokens: readonly Token[]): string {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  return first && last ? source.slice(first.start, last.end) : "";
}

/** The value of a string literal token, for literal types (simple escapes only; others are `unknown`). */
function stringValue(text: string): string | undefined {
  const body = text.slice(1, -1);
  if (!body.includes("\\")) return body;
  try {
    return JSON.parse(`"${body.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) as string;
  } catch {
    return undefined;
  }
}

/** Members of a union, flattened and deduplicated; a single member is itself. */
export function union(members: readonly SpecType[]): SpecType {
  const flat: SpecType[] = [];
  const seen = new Set<string>();
  for (const m of members)
    for (const x of m.kind === "union" ? m.members : [m]) {
      const key = JSON.stringify(x);
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(x);
    }
  return flat.length === 1 ? (flat[0] as SpecType) : { kind: "union", members: flat };
}

/**
 * The whole token list as one type. A construct the reader does not
 * read makes the type (or the field, or the union member) `unknown`.
 */
export function readType(tokens: readonly Token[], env: TypeEnv): SpecType {
  if (tokens.length === 0) return unknown("");
  const r = new TypeReader(tokens, env);
  const t = r.union();
  if (r.at < tokens.length) return unknown(textOf(env.source, tokens));
  return t;
}

class TypeReader {
  at = 0;
  readonly tokens: readonly Token[];
  readonly env: TypeEnv;
  // No parameter properties: Node's type stripping, which runs these sources directly, rejects them.
  constructor(tokens: readonly Token[], env: TypeEnv) {
    this.tokens = tokens;
    this.env = env;
  }

  peek(n = 0): Token | undefined {
    return this.tokens[this.at + n];
  }

  /** The text from token `from` to the current position, for an `unknown`. */
  since(from: number): string {
    return textOf(this.env.source, this.tokens.slice(from, Math.max(from + 1, this.at)));
  }

  union(): SpecType {
    const from = this.at;
    if (isPunct(this.peek(), "|")) this.at++;
    const members = [this.intersection()];
    while (isPunct(this.peek(), "|")) {
      this.at++;
      members.push(this.intersection());
    }
    // One unreadable member keeps its own text; the union's shape still shows.
    return members.length === 1
      ? (members[0] as SpecType)
      : union(members) || unknown(this.since(from));
  }

  intersection(): SpecType {
    const from = this.at;
    const first = this.postfix();
    if (!isPunct(this.peek(), "&")) return first;
    while (isPunct(this.peek(), "&")) {
      this.at++;
      this.postfix();
    }
    return unknown(this.since(from));
  }

  postfix(): SpecType {
    const from = this.at;
    const t = this.primary();
    let indexed = false;
    while (isPunct(this.peek(), "[")) {
      indexed = true;
      this.at = skipGroup(this.tokens, this.at);
    }
    return indexed ? unknown(this.since(from)) : t;
  }

  primary(): SpecType {
    const from = this.at;
    const t = this.peek();
    if (!t) return unknown("");
    this.at++;
    switch (t.kind) {
      case "string": {
        const value = stringValue(t.text);
        return value === undefined ? unknown(t.text) : { kind: "literal", value };
      }
      case "number": {
        const value = Number(t.text.replace(/_/g, ""));
        return Number.isFinite(value) && !t.text.endsWith("n")
          ? { kind: "literal", value }
          : unknown(t.text);
      }
      case "punct":
        if (t.text === "{") {
          this.at--;
          return this.record();
        }
        if (t.text === "(") {
          const inner = this.union();
          if (!isPunct(this.peek(), ")")) return unknown(this.since(from));
          this.at++;
          return inner;
        }
        if (t.text === "-" && this.peek()?.kind === "number") {
          const n = this.peek() as Token;
          this.at++;
          const value = -Number(n.text.replace(/_/g, ""));
          return Number.isFinite(value) ? { kind: "literal", value } : unknown(this.since(from));
        }
        return unknown(this.since(from));
      case "ident":
        return this.named(t, from);
      default:
        return unknown(this.since(from));
    }
  }

  /** A keyword type, a literal keyword, a type parameter or a declared name with its arguments. */
  named(t: Token, from: number): SpecType {
    switch (t.text) {
      case "number":
      case "boolean":
      case "string":
      case "bigint":
      case "null":
      case "undefined":
        return { kind: t.text };
      case "true":
      case "false":
        return { kind: "literal", value: t.text === "true" };
      case "readonly":
        // `readonly T[]`: an array, whatever follows.
        this.postfix();
        return unknown(this.since(from));
      case "typeof":
      case "keyof":
        this.postfix();
        return unknown(this.since(from));
    }
    // A qualified name (`ns.T`) is not the module's own.
    if (isPunct(this.peek(), ".")) {
      while (isPunct(this.peek(), ".") && this.peek(1)?.kind === "ident") this.at += 2;
      if (isPunct(this.peek(), "<")) this.at = skipAngles(this.tokens, this.at);
      return unknown(this.since(from));
    }
    const bound = this.env.bindings.get(t.text);
    if (bound && !isPunct(this.peek(), "<")) return bound;
    const args: SpecType[] = [];
    if (isPunct(this.peek(), "<")) {
      const end = skipAngles(this.tokens, this.at);
      const inner = this.tokens.slice(this.at + 1, end - 1);
      for (const group of splitTopLevel(inner, ",")) args.push(readType(group, this.env));
      this.at = end;
    }
    const decl = this.env.declarations.get(t.text);
    if (!decl) return unknown(this.since(from));
    if (decl.unsupported) return unknown(this.since(from));
    if (this.env.expanding.has(t.text)) return unknown(this.since(from));
    if (args.length > decl.params.length) return unknown(this.since(from));
    const bindings = new Map(this.env.bindings);
    decl.params.forEach((p, i) => {
      bindings.set(p, args[i] ?? unknown(p));
    });
    const expanded = readType(decl.tokens, {
      ...this.env,
      bindings,
      expanding: new Set([...this.env.expanding, t.text]),
    });
    const name = this.since(from);
    // A declared record keeps its name; an alias of a union is the union.
    return expanded.kind === "record" && expanded.name === undefined
      ? { ...expanded, name }
      : expanded;
  }

  /** `{ readonly? name: T; … }`. A method, an index signature, an optional field or a computed key makes it unknown. */
  record(): SpecType {
    const from = this.at;
    const end = skipGroup(this.tokens, this.at);
    const inner = this.tokens.slice(this.at + 1, end - 1);
    this.at = end;
    const fields: Field[] = [];
    for (const member of splitMembers(inner)) {
      let i = 0;
      if (isWord(member[i], "readonly")) i++;
      const name = member[i];
      if (name?.kind !== "ident") return unknown(this.since(from));
      i++;
      if (isPunct(member[i], "?")) return unknown(this.since(from));
      if (!isPunct(member[i], ":")) return unknown(this.since(from));
      const type = readType(member.slice(i + 1), this.env);
      fields.push({ name: name.text, type });
    }
    return { kind: "record", fields };
  }
}

/** Split tokens at a top-level punctuator. */
function splitTopLevel(tokens: readonly Token[], at: string): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct") {
      if (opens.has(t.text) || t.text === "<") depth++;
      else if (closes.has(t.text)) depth--;
      else if (/^>+$/.test(t.text)) depth -= t.text.length;
      else if (t.text === at && depth === 0) {
        out.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  if (current.length > 0 || out.length > 0) out.push(current);
  return out.filter((g) => g.length > 0);
}

/** Members of a type literal: separated by `;`, `,` or a line break between members. */
function splitMembers(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct") {
      if (opens.has(t.text) || t.text === "<") depth++;
      else if (closes.has(t.text)) depth--;
      else if (/^>+$/.test(t.text)) depth -= t.text.length;
      else if ((t.text === ";" || t.text === ",") && depth === 0) {
        if (current.length > 0) out.push(current);
        current = [];
        continue;
      }
    }
    // A new member starts at a name (or readonly) at depth 0 right after a complete member: `a: T\n b: U`.
    if (
      depth === 0 &&
      current.length >= 3 &&
      (t.kind === "ident" || t.kind === "string") &&
      isNameStart(current, t)
    ) {
      out.push(current);
      current = [];
    }
    current.push(t);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Whether `t` starts a new member after `current` (a member is `name: type`; a type never ends in a keyword or name followed by a name on a later line). */
function isNameStart(current: readonly Token[], t: Token): boolean {
  const last = current[current.length - 1] as Token;
  if (last.kind === "punct") return false; // a type continues: `|`, `,`, `<`…
  const next = t.kind === "ident" ? t : undefined;
  return next !== undefined && last.end < t.start;
}
