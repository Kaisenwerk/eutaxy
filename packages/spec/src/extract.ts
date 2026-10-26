/**
 * Find the Lemma annotations in a TypeScript module: JSDoc blocks with
 * `@ensures{name}`, `@total` or `@throws` on exported function
 * declarations, where Lemma says they attach. A tag counts at the start of
 * a JSDoc line; an `@ensures` property runs to the next tag or the end of
 * the comment. Also lists the module's exported value names, which are the
 * free identifiers a property may use.
 */

import type { FunctionSpec, ModuleSpecs, NamedProperty, SpecError } from "./ir.ts";
import { LemmaSyntaxError, parseProperty } from "./parse.ts";
import { type Token, TokenizeError, tokenize } from "./tokens.ts";

const tagLine = /^@(\w+)(?:\{([^}]*)\})?/;

interface Tag {
  readonly name: string;
  readonly label: string | undefined;
  readonly text: string;
  readonly line: number;
}

/** The JSDoc's tags, each with its text up to the next tag. */
function tags(comment: Token, lineOf: (offset: number) => number): Tag[] {
  const body = comment.text.slice(3, -2);
  const first = lineOf(comment.start);
  const out: { name: string; label: string | undefined; lines: string[]; line: number }[] = [];
  body.split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s*\*?\s?/, "");
    const m = tagLine.exec(line.trimStart());
    if (m) {
      out.push({
        name: m[1] as string,
        label: m[2],
        lines: [line.trimStart().slice(m[0].length)],
        line: first + i,
      });
    } else out[out.length - 1]?.lines.push(line);
  });
  return out.map((t) => ({
    name: t.name,
    label: t.label,
    text: t.lines.join("\n").trim(),
    line: t.line,
  }));
}

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === "ident" && t.text === w;
const isPunct = (t: Token | undefined, p: string): boolean => t?.kind === "punct" && t.text === p;

/** `export [async] function [*] name(` at `i`: the name and the index of `(`. */
function functionAt(tokens: readonly Token[], i: number): { name: string; open: number } | null {
  if (!isWord(tokens[i], "export")) return null;
  let j = i + 1;
  if (isWord(tokens[j], "async")) j++;
  if (!isWord(tokens[j], "function")) return null;
  j++;
  if (isPunct(tokens[j], "*")) j++;
  const name = tokens[j];
  if (name?.kind !== "ident") return null;
  j++;
  if (isPunct(tokens[j], "<")) j = skipAngles(tokens, j);
  return isPunct(tokens[j], "(") ? { name: name.text, open: j } : null;
}

/** The index after the `>` closing the type parameters opened at `i`. */
function skipAngles(tokens: readonly Token[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.kind !== "punct") continue;
    if (t.text === "<") depth++;
    else if (t.text === ">" || t.text === ">>" || t.text === ">>>") {
      depth -= t.text.length;
      if (depth <= 0) return j + 1;
    }
  }
  return tokens.length;
}

/**
 * Parameter names of the list opened at `open`; null for destructured and
 * rest parameters. `ambiguous` when a default value has a top-level `<` or
 * `>`: a comparison or a generic call's type arguments (`pair<A, B>()`),
 * which a token scan cannot tell apart, and guessing wrong would bind a
 * binder to another parameter's argument.
 */
function params(
  tokens: readonly Token[],
  open: number,
): { names: (string | null)[]; ambiguous: boolean } {
  const firsts: Token[] = [];
  let depth = 0;
  let start = true;
  // Angle brackets are type arguments only in a parameter's type annotation, not its default value.
  let inType = false;
  let inDefault = false;
  let ambiguous = false;
  for (let j = open + 1; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (depth === 0 && isPunct(t, ")")) break;
    if (start) firsts.push(t);
    start = false;
    if (t.kind !== "punct") continue;
    if (inDefault && depth === 0 && /^(<|>)/.test(t.text) && t.text !== ">=" && t.text !== "<=")
      ambiguous = true;
    if (["(", "[", "{"].includes(t.text) || (inType && t.text === "<")) depth++;
    else if ([")", "]", "}"].includes(t.text)) depth--;
    // Closing type arguments: `>`, or `>>` closing two.
    else if (inType && /^>+$/.test(t.text)) depth -= t.text.length;
    else if (depth === 0 && t.text === ":") inType = true;
    else if (depth === 0 && t.text === "=") {
      inType = false;
      inDefault = true;
    } else if (t.text === "," && depth === 0) {
      start = true;
      inType = false;
      inDefault = false;
    }
  }
  // A `this` parameter is a type annotation only, not an argument.
  const names = firsts
    .filter((t) => !isWord(t, "this"))
    .map((t) => (t.kind === "ident" ? t.text : null));
  return { names, ambiguous };
}

/** Names the module exports as values (not types). */
function exportedNames(tokens: readonly Token[]): string[] {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "export")) continue;
    let j = i + 1;
    if (isWord(tokens[j], "declare")) j++;
    if (isWord(tokens[j], "default")) continue;
    if (isWord(tokens[j], "async")) j++;
    if (isWord(tokens[j], "abstract")) j++;
    const kw = tokens[j];
    if (["function", "class", "enum"].some((w) => isWord(kw, w))) {
      let k = j + 1;
      if (isPunct(tokens[k], "*")) k++;
      if (tokens[k]?.kind === "ident") names.add((tokens[k] as Token).text);
    } else if (["const", "let", "var"].some((w) => isWord(kw, w))) {
      // Every name declared at this declaration's top level: `export const a = 1, b = 2`.
      let depth = 0;
      let expectName = true;
      for (let k = j + 1; k < tokens.length; k++) {
        const t = tokens[k] as Token;
        if (expectName && depth === 0 && t.kind === "ident") names.add(t.text);
        expectName = false;
        if (t.kind !== "punct") continue;
        if (["(", "[", "{"].includes(t.text)) depth++;
        else if ([")", "]", "}"].includes(t.text)) depth--;
        else if (t.text === "," && depth === 0) expectName = true;
        else if (t.text === ";" && depth === 0) break;
        if (depth < 0) break;
      }
    } else if (isPunct(kw, "{")) {
      const close = tokens.findIndex((t, k) => k > j && isPunct(t, "}"));
      if (close < 0 || isWord(tokens[close + 1], "from")) continue;
      for (let k = j + 1; k < close; k++) {
        const t = tokens[k] as Token;
        if (t.kind !== "ident" || isWord(tokens[k - 1], "type")) continue;
        if (isWord(tokens[k + 1], "as")) continue;
        if (isWord(t, "as") || isWord(t, "type")) continue;
        names.add(t.text);
      }
    }
  }
  return [...names];
}

export function extractSpecs(source: string): ModuleSpecs {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let all: Token[];
  try {
    all = tokenize(source, { comments: true });
  } catch (err) {
    if (err instanceof TokenizeError)
      return { functions: [], exports: [], errors: [{ line: 1, message: err.message }] };
    throw err;
  }
  const code = all.filter((t) => t.kind !== "comment");
  const indexOf = new Map(code.map((t, i) => [t, i]));
  const errors: SpecError[] = [];
  const functions: FunctionSpec[] = [];
  all.forEach((comment, i) => {
    if (comment.kind !== "comment" || !comment.text.startsWith("/**")) return;
    const found = tags(comment, lineOf).filter((t) =>
      ["ensures", "total", "throws"].includes(t.name),
    );
    if (found.length === 0) return;
    const next = all.slice(i + 1).find((t) => t.kind !== "comment");
    const decl = next ? functionAt(code, indexOf.get(next) ?? -1) : null;
    if (!decl) {
      errors.push({
        line: found[0]?.line ?? lineOf(comment.start),
        message: "Lemma annotations attach to an exported function declaration",
      });
      return;
    }
    const ensures: NamedProperty[] = [];
    for (const t of found) {
      if (t.name !== "ensures") continue;
      const name = t.label?.trim();
      if (!name) {
        errors.push({
          line: t.line,
          message: "@ensures needs a name, as in @ensures{non-negative}",
        });
        continue;
      }
      if (ensures.some((e) => e.name === name)) {
        errors.push({ line: t.line, message: `${decl.name} has two properties named ${name}` });
        continue;
      }
      try {
        ensures.push({ name, property: parseProperty(t.text), text: t.text });
      } catch (err) {
        if (!(err instanceof LemmaSyntaxError)) throw err;
        errors.push({ line: t.line, message: `@ensures{${name}} on ${decl.name}: ${err.message}` });
      }
    }
    if (functions.some((f) => f.name === decl.name)) {
      // Overloads: each declaration's binders could differ, and a property is checked against one signature.
      errors.push({
        line: lineOf((code[decl.open] as Token).start),
        message: `${decl.name} is annotated on more than one declaration (overloads): put its annotations on one`,
      });
      return;
    }
    const signature = params(code, decl.open);
    if (signature.ambiguous)
      errors.push({
        line: lineOf((code[decl.open] as Token).start),
        message: `cannot tell the parameters of ${decl.name} apart: a default value has a top-level < or >; parenthesize it`,
      });
    functions.push({
      name: decl.name,
      params: signature.names,
      ensures,
      total: found.some((t) => t.name === "total"),
      throws: found.some((t) => t.name === "throws"),
      line: lineOf((code[decl.open] as Token).start),
      offset: (code[decl.open] as Token).start,
    });
  });
  return { functions, exports: exportedNames(code), errors };
}
