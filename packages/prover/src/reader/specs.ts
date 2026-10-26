/**
 * A module and its spec file read into `ModuleSpecs`. From the module:
 * the exported functions and their parameter types (`function`
 * declarations and `const` arrows alike), through the type reader. From
 * the spec file: every `export const name = forall(f, { when, ensures })`
 * and `total(f)`, with the combinators imported from `eutaxy/spec` and `f`
 * from the module; the arrows are kept as text, their parameter names
 * naming the binders, and the precondition's conjuncts about one
 * parameter become that binder's hint. Anything else is an error with a
 * line, never a guess.
 */

import type {
  Arrow,
  Binder,
  Endpoint,
  FunctionSpec,
  Hint,
  ModuleSpecs,
  Param,
  Property,
  SpecError,
  SpecType,
} from "@eutaxy/spec";
import { type Token, TokenizeError, tokenize } from "./tokens.ts";
import { readType, type TypeDeclaration, typeDeclarations, union } from "./types.ts";

export interface ReadSpecsInput {
  /** The module's source. */
  readonly module: string;
  /** The spec file's source. */
  readonly spec: string;
  /** Every import specifier that names the module from the spec file ("./domain.ts", "./domain", "./domain.js"). */
  readonly moduleSpecifiers: readonly string[];
  /** Specifiers the combinators come from; `eutaxy/spec` and the workspace name by default. */
  readonly specSpecifiers?: readonly string[];
}

const isPunct = (t: Token | undefined, text: string): boolean =>
  t?.kind === "punct" && t.text === text;
const isWord = (t: Token | undefined, text: string): boolean =>
  t?.kind === "ident" && t.text === text;
const opens = new Set(["(", "[", "{"]);
const closes = new Set([")", "]", "}"]);

/** Line of an offset, every JavaScript line terminator counted. */
function lineIndex(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\r") {
      if (source[i + 1] === "\n") i++;
      starts.push(i + 1);
    } else if (c === "\n" || c === " " || c === " ") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

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

/**
 * Split at a top-level punctuator. Angle brackets count as a group where
 * types may appear (parameter lists, imports); in an expression `<` is a
 * comparison and does not.
 */
function splitTopLevel(tokens: readonly Token[], at: string, angles = true): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === "punct") {
      if (opens.has(t.text) || (angles && t.text === "<")) depth++;
      else if (closes.has(t.text)) depth--;
      else if (angles && /^>+$/.test(t.text)) depth -= t.text.length;
      else if (t.text === at && depth === 0) {
        out.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  out.push(current);
  return out.filter((g) => g.length > 0);
}

// ---------------------------------------------------------------------------
// The module: exported functions and their parameter types.

interface Declaration {
  readonly name: string;
  readonly params: readonly Param[];
  readonly line: number;
  readonly offset: number;
}

interface ModuleSide {
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** Exported name to local declaration name. */
  readonly exports: ReadonlyMap<string, string>;
  readonly errors: readonly SpecError[];
}

/**
 * The parameters of the list opened at `open`: `name?: T = default`,
 * `...rest`, destructured. The index past the `)` is returned with them.
 */
function readParams(
  tokens: readonly Token[],
  open: number,
  types: { readonly source: string; readonly declarations: ReadonlyMap<string, TypeDeclaration> },
): { params: Param[]; end: number } {
  const end = skipGroup(tokens, open);
  const inner = tokens.slice(open + 1, end - 1);
  const params: Param[] = [];
  for (const group of splitTopLevel(inner, ",")) {
    let i = 0;
    let name: string | null = null;
    let rest = false;
    if (isPunct(group[i], "...")) {
      rest = true;
      i++;
    }
    const head = group[i];
    if (head?.kind === "ident") {
      name = head.text;
      i++;
    } else if (head?.kind === "punct" && (head.text === "{" || head.text === "[")) {
      i = skipGroup(group, i);
    }
    if (name === "this") continue; // a receiver annotation, no argument
    let optional = false;
    if (isPunct(group[i], "?")) {
      optional = true;
      i++;
    }
    let type: SpecType = { kind: "unknown", text: "(no type annotation)" };
    if (isPunct(group[i], ":")) {
      i++;
      let j = i;
      let depth = 0;
      while (j < group.length) {
        const t = group[j] as Token;
        if (t.kind === "punct") {
          if (opens.has(t.text) || t.text === "<") depth++;
          else if (closes.has(t.text)) depth--;
          else if (/^>+$/.test(t.text)) depth -= t.text.length;
          else if (t.text === "=" && depth === 0) break;
        }
        j++;
      }
      type = readType(group.slice(i, j), {
        source: types.source,
        declarations: types.declarations,
        bindings: new Map(),
        expanding: new Set(),
      });
      i = j;
    }
    if (isPunct(group[i], "=")) optional = true; // a default: the caller may pass undefined
    if (rest) type = { kind: "unknown", text: `...${name ?? ""}` };
    else if (optional) type = union([type, { kind: "undefined" }]);
    params.push({ name: rest ? null : name, type });
  }
  return { params, end };
}

/**
 * Whether the `function` at `i` is a declaration (not an expression): at
 * the start of the module, after a statement end, or on a new line after
 * a finished statement (automatic semicolon insertion), with `export` and
 * `async` allowed in front.
 */
function isFunctionDeclaration(
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
  if (lineOf(before.end) === lineOf((tokens[i] as Token).start)) return false;
  if (before.kind === "punct") return [")", "]", "++", "--"].includes(before.text);
  if (before.kind === "ident")
    return !"return typeof void new else case in of do yield await delete instanceof throw export default async"
      .split(" ")
      .includes(before.text);
  return true;
}

function readModuleSide(source: string): ModuleSide {
  const errors: SpecError[] = [];
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    if (!(err instanceof TokenizeError)) throw err;
    errors.push({
      line: 1,
      message: `the module could not be tokenized: ${err.message}`,
      inModule: true,
    });
    return { declarations: new Map(), exports: new Map(), errors };
  }
  const lineOf = lineIndex(source);
  const declarations = new Map<string, Declaration>();
  const exports = new Map<string, string>();
  const types = { source, declarations: typeDeclarations(tokens, lineOf) };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && opens.has(t.text)) {
      i = skipGroup(tokens, i);
      continue;
    }
    if (t.kind !== "ident") {
      i++;
      continue;
    }
    if (t.text === "export" && isPunct(tokens[i + 1], "{")) {
      // `export { a, b as c }`; with `from`, a re-export of another module's names (not this module's).
      const end = skipGroup(tokens, i + 1);
      if (!isWord(tokens[end], "from"))
        for (const group of splitTopLevel(tokens.slice(i + 2, end - 1), ",")) {
          if (isWord(group[0], "type")) continue;
          const local = group[0];
          const exported = isWord(group[1], "as") ? group[2] : group[0];
          if (local?.kind === "ident" && exported?.kind === "ident")
            exports.set(exported.text, local.text);
        }
      i = end;
      continue;
    }
    if (t.text === "function" && isFunctionDeclaration(tokens, i, lineOf)) {
      let j = i + 1;
      if (isPunct(tokens[j], "*")) j++;
      const name = tokens[j];
      if (name?.kind !== "ident") {
        i++;
        continue;
      }
      j++;
      if (isPunct(tokens[j], "<")) {
        // Type parameters: skip to the parameter list.
        let depth = 0;
        for (; j < tokens.length; j++) {
          const u = tokens[j] as Token;
          if (u.kind !== "punct") continue;
          if (u.text === "<") depth++;
          else if (/^>+$/.test(u.text)) {
            depth -= u.text.length;
            if (depth <= 0) {
              j++;
              break;
            }
          }
        }
      }
      if (!isPunct(tokens[j], "(")) {
        i++;
        continue;
      }
      let k = i - 1;
      let exported = false;
      while (
        tokens[k]?.kind === "ident" &&
        ["async", "export", "default"].includes(tokens[k]?.text ?? "")
      ) {
        if (tokens[k]?.text === "export") exported = true;
        k--;
      }
      const read = readParams(tokens, j, types);
      if (!declarations.has(name.text))
        declarations.set(name.text, {
          name: name.text,
          params: read.params,
          line: lineOf(t.start),
          offset: (tokens[j] as Token).start,
        });
      else
        errors.push({
          line: lineOf(t.start),
          message: `${name.text} is declared more than once (overloads): a spec is checked against one signature`,
          inModule: true,
        });
      if (exported) exports.set(name.text, name.text);
      i = read.end;
      continue;
    }
    if (t.text === "const" || t.text === "let" || t.text === "var") {
      // `export const f = (a: T): R => …` or `= function (a: T) …`: a function by another declaration.
      const exported = isWord(tokens[i - 1], "export");
      const name = tokens[i + 1];
      if (name?.kind !== "ident" || !isPunct(tokens[i + 2], "=")) {
        i++;
        continue;
      }
      let j = i + 3;
      if (isWord(tokens[j], "async")) j++;
      if (isWord(tokens[j], "function")) {
        j++;
        if (isPunct(tokens[j], "*")) j++;
        if (tokens[j]?.kind === "ident") j++;
      }
      if (!isPunct(tokens[j], "(")) {
        i++;
        continue;
      }
      const close = skipGroup(tokens, j);
      // An arrow: `)` then `=>`, or `):` a return type then `=>`; a function expression: `)` then `{` or `:`.
      let k = close;
      if (isPunct(tokens[k], ":")) {
        let depth = 0;
        for (; k < tokens.length; k++) {
          const u = tokens[k] as Token;
          if (u.kind !== "punct") continue;
          if (opens.has(u.text) || u.text === "<") depth++;
          else if (closes.has(u.text)) depth--;
          else if (/^>+$/.test(u.text)) depth -= u.text.length;
          else if (u.text === "=>" && depth === 0) break;
          if (depth < 0) break;
        }
      }
      const isFunction = isPunct(tokens[k], "=>") || isPunct(tokens[close], "{");
      if (!isFunction) {
        i++;
        continue;
      }
      const read = readParams(tokens, j, types);
      if (!declarations.has(name.text))
        declarations.set(name.text, {
          name: name.text,
          params: read.params,
          line: lineOf(t.start),
          offset: (tokens[j] as Token).start,
        });
      if (exported) exports.set(name.text, name.text);
      i = read.end;
      continue;
    }
    i++;
  }
  return { declarations, exports, errors };
}

// ---------------------------------------------------------------------------
// The spec file.

interface Imported {
  readonly from: string;
  /** The exported name imported; `*` for a namespace import. */
  readonly name: string;
}

/** `import { a, b as c } from "x"`, `import * as ns from "x"`, `import d from "x"`; type-only imports skipped. */
function imports(tokens: readonly Token[]): Map<string, Imported> {
  const out = new Map<string, Imported>();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && opens.has(t.text)) {
      i = skipGroup(tokens, i);
      continue;
    }
    if (!isWord(t, "import") || isPunct(tokens[i + 1], "(")) {
      i++;
      continue;
    }
    let j = i + 1;
    const typeOnly =
      isWord(tokens[j], "type") && !isPunct(tokens[j + 1], ",") && !isWord(tokens[j + 1], "from");
    if (typeOnly) j++;
    const bound: { local: string; name: string }[] = [];
    if (tokens[j]?.kind === "ident" && !isWord(tokens[j], "from")) {
      bound.push({ local: (tokens[j] as Token).text, name: "default" });
      j++;
      if (isPunct(tokens[j], ",")) j++;
    }
    if (isPunct(tokens[j], "*")) {
      j++;
      if (isWord(tokens[j], "as") && tokens[j + 1]?.kind === "ident") {
        bound.push({ local: (tokens[j + 1] as Token).text, name: "*" });
        j += 2;
      }
    } else if (isPunct(tokens[j], "{")) {
      const end = skipGroup(tokens, j);
      for (const group of splitTopLevel(tokens.slice(j + 1, end - 1), ",")) {
        let g = 0;
        if (isWord(group[g], "type") && group.length > 1) continue;
        const name = group[g];
        if (name?.kind !== "ident" && name?.kind !== "string") continue;
        g++;
        const local = isWord(group[g], "as") ? group[g + 1] : name;
        if (local?.kind !== "ident") continue;
        bound.push({
          local: local.text,
          name: name.kind === "string" ? name.text.slice(1, -1) : name.text,
        });
      }
      j = end;
    }
    if (!isWord(tokens[j], "from")) {
      i = j;
      continue;
    }
    const from = tokens[j + 1];
    if (from?.kind === "string" && !typeOnly)
      for (const b of bound) out.set(b.local, { from: from.text.slice(1, -1), name: b.name });
    i = j + 2;
  }
  return out;
}

/** The arrow's parameter names; null for a destructured one. Type annotations and defaults are skipped. */
function arrowParams(tokens: readonly Token[]): (string | null)[] {
  return splitTopLevel(tokens, ",").map((group) => {
    const head = group[0];
    return head?.kind === "ident" ? head.text : null;
  });
}

/** `1`, `-1`, `1_000`, `1.5` as an endpoint value; undefined otherwise. */
function numberText(tokens: readonly Token[]): string | undefined {
  if (tokens.length === 1 && tokens[0]?.kind === "number") return tokens[0].text.replace(/_/g, "");
  if (tokens.length === 2 && isPunct(tokens[0], "-") && tokens[1]?.kind === "number")
    return `-${tokens[1].text.replace(/_/g, "")}`;
  return undefined;
}

/**
 * What the precondition says about each of its parameters on its own: its
 * top-level conjuncts of the forms `Number.isInteger(x)`, `x < n`, `n <= x`
 * (and the other comparisons) and `/re/.test(x)`, by parameter index.
 */
export function hintsOf(arrow: Arrow): Map<number, Hint> {
  const out = new Map<number, Hint>();
  if (arrow.block) return out;
  let tokens: Token[];
  try {
    tokens = tokenize(arrow.body);
  } catch {
    return out;
  }
  const position = new Map<string, number>();
  arrow.params.forEach((p, i) => {
    if (p !== null) position.set(p, i);
  });
  const merge = (i: number, h: Hint) => {
    const old = out.get(i) ?? {};
    out.set(i, { ...old, ...h });
  };
  for (let conjunct of splitTopLevel(tokens, "&&", false)) {
    while (
      conjunct.length >= 2 &&
      isPunct(conjunct[0], "(") &&
      skipGroup(conjunct, 0) === conjunct.length
    )
      conjunct = conjunct.slice(1, -1);
    // Number.isInteger(x)
    if (
      conjunct.length === 6 &&
      isWord(conjunct[0], "Number") &&
      isPunct(conjunct[1], ".") &&
      isWord(conjunct[2], "isInteger") &&
      isPunct(conjunct[3], "(") &&
      conjunct[4]?.kind === "ident" &&
      isPunct(conjunct[5], ")")
    ) {
      const at = position.get(conjunct[4].text);
      if (at !== undefined) merge(at, { integer: true });
      continue;
    }
    // /re/.test(x)
    if (
      conjunct.length === 6 &&
      conjunct[0]?.kind === "regex" &&
      isPunct(conjunct[1], ".") &&
      isWord(conjunct[2], "test") &&
      isPunct(conjunct[3], "(") &&
      conjunct[4]?.kind === "ident" &&
      isPunct(conjunct[5], ")")
    ) {
      const at = position.get(conjunct[4].text);
      const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(conjunct[0].text);
      if (at !== undefined && m)
        merge(at, { regex: { pattern: m[1] as string, flags: m[2] as string } });
      continue;
    }
    // x op n, n op x
    const opAt = conjunct.findIndex(
      (t) => t.kind === "punct" && ["<", "<=", ">", ">="].includes(t.text),
    );
    if (opAt < 0) continue;
    const op = (conjunct[opAt] as Token).text;
    const left = conjunct.slice(0, opAt);
    const right = conjunct.slice(opAt + 1);
    const bound = (variable: Token[], literal: Token[], variableOnLeft: boolean) => {
      const name =
        variable.length === 1 && variable[0]?.kind === "ident" ? variable[0].text : undefined;
      const value = numberText(literal);
      if (name === undefined || value === undefined) return;
      const at = position.get(name);
      if (at === undefined) return;
      // `x < n` bounds x above; `n < x` bounds it below.
      const above = variableOnLeft ? op.startsWith("<") : op.startsWith(">");
      const endpoint: Endpoint = { value, inclusive: op.endsWith("=") };
      merge(at, above ? { upper: endpoint } : { lower: endpoint });
    };
    if (left.length === 1 && left[0]?.kind === "ident") bound(left, right, true);
    else if (right.length === 1 && right[0]?.kind === "ident") bound(right, left, false);
  }
  return out;
}

interface SpecExport {
  readonly name: string;
  readonly kind: "forall" | "total";
  readonly fn: string;
  readonly when?: Arrow;
  readonly ensures?: Arrow;
  readonly text: string;
  readonly line: number;
}

class SpecFail extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

/** The module's exports the spec file imports by name, as `local` to exported `name`. */
interface ModuleImport {
  readonly local: string;
  readonly name: string;
}

/** Read the spec file's exports. */
function readSpecSide(
  source: string,
  moduleSpecifiers: ReadonlySet<string>,
  specSpecifiers: ReadonlySet<string>,
): { specs: SpecExport[]; errors: SpecError[]; imports: ModuleImport[] } {
  const errors: SpecError[] = [];
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    if (!(err instanceof TokenizeError)) throw err;
    return {
      specs: [],
      errors: [{ line: 1, message: `the spec file could not be tokenized: ${err.message}` }],
      imports: [],
    };
  }
  const lineOf = lineIndex(source);
  const bound = imports(tokens);
  const specs: SpecExport[] = [];
  const fail: (message: string, t: Token | undefined) => never = (message, t) => {
    throw new SpecFail(message, t ? lineOf(t.start) : lineOf(source.length));
  };
  /** The combinator a callee names (`forall`, `ns.forall`), or undefined. */
  const combinator = (i: number): { kind: "forall" | "total"; next: number } | undefined => {
    const t = tokens[i];
    if (t?.kind !== "ident") return undefined;
    if (isPunct(tokens[i + 1], ".") && tokens[i + 2]?.kind === "ident") {
      const ns = bound.get(t.text);
      const member = (tokens[i + 2] as Token).text;
      if (
        ns?.name === "*" &&
        specSpecifiers.has(ns.from) &&
        (member === "forall" || member === "total")
      )
        return { kind: member, next: i + 3 };
      return undefined;
    }
    const imp = bound.get(t.text);
    if (imp && specSpecifiers.has(imp.from) && (imp.name === "forall" || imp.name === "total"))
      return { kind: imp.name, next: i + 1 };
    return undefined;
  };
  /** The module function a first argument names, or why not. */
  const functionArg = (i: number): { fn: string; next: number } => {
    const t = tokens[i];
    if (t?.kind !== "ident")
      return fail(
        `the first argument must name a function of the module, found ${t?.text ?? "the end"}`,
        t,
      );
    if (isPunct(tokens[i + 1], ".") && tokens[i + 2]?.kind === "ident") {
      const ns = bound.get(t.text);
      if (ns?.name === "*" && moduleSpecifiers.has(ns.from))
        return { fn: (tokens[i + 2] as Token).text, next: i + 3 };
      return fail(
        `${t.text}.${(tokens[i + 2] as Token).text} is not a function imported from the module`,
        t,
      );
    }
    const imp = bound.get(t.text);
    if (!imp)
      return fail(
        `${t.text} is not imported from the module (import it from ${[...moduleSpecifiers][0]})`,
        t,
      );
    if (!moduleSpecifiers.has(imp.from))
      return fail(
        `${t.text} is imported from ${JSON.stringify(imp.from)}, not from the module beside this spec file`,
        t,
      );
    if (imp.name === "*" || imp.name === "default")
      return fail(`${t.text} must be a named import of the module's function`, t);
    return { fn: imp.name, next: i + 1 };
  };
  /** An arrow function at `i`: its params, body text and whether the body is a block; the index past it. */
  const arrow = (i: number, what: string): { arrow: Arrow; next: number } => {
    const start = tokens[i];
    if (isWord(start, "async")) fail(`${what} is an async arrow; it must be synchronous`, start);
    let params: (string | null)[];
    let j: number;
    if (isPunct(start, "(")) {
      const end = skipGroup(tokens, i);
      params = arrowParams(tokens.slice(i + 1, end - 1));
      j = end;
      // A return type annotation before the arrow is skipped.
      if (isPunct(tokens[j], ":")) {
        let depth = 0;
        for (; j < tokens.length; j++) {
          const u = tokens[j] as Token;
          if (u.kind !== "punct") continue;
          if (opens.has(u.text) || u.text === "<") depth++;
          else if (closes.has(u.text)) depth--;
          else if (/^>+$/.test(u.text)) depth -= u.text.length;
          else if (u.text === "=>" && depth === 0) break;
        }
      }
    } else if (start?.kind === "ident" && isPunct(tokens[i + 1], "=>")) {
      params = [start.text];
      j = i + 1;
    } else
      return fail(`${what} must be an arrow function, found ${start?.text ?? "the end"}`, start);
    if (!isPunct(tokens[j], "=>"))
      return fail(`${what} must be an arrow function (no => after its parameters)`, start);
    j++;
    const first = tokens[j];
    if (!first) return fail(`${what} has no body`, start);
    if (isPunct(first, "{")) {
      const end = skipGroup(tokens, j);
      const last = tokens[end - 1] as Token;
      return {
        arrow: {
          params,
          body: source.slice(first.end, last.start),
          block: true,
          line: lineOf((start as Token).start),
        },
        next: end,
      };
    }
    // An expression body runs to the `,` or `}` that ends the property.
    let depth = 0;
    let k = j;
    for (; k < tokens.length; k++) {
      const u = tokens[k] as Token;
      if (u.kind !== "punct") continue;
      if (opens.has(u.text)) depth++;
      else if (closes.has(u.text)) {
        if (depth === 0) break;
        depth--;
      } else if (u.text === "," && depth === 0) break;
    }
    const last = tokens[k - 1] as Token;
    return {
      arrow: {
        params,
        body: source.slice(first.start, last.end),
        block: false,
        line: lineOf((start as Token).start),
      },
      next: k,
    };
  };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === "punct" && opens.has(t.text)) {
      i = skipGroup(tokens, i);
      continue;
    }
    if (t.kind !== "ident" || (t.text !== "const" && t.text !== "let" && t.text !== "var")) {
      i++;
      continue;
    }
    const exported = isWord(tokens[i - 1], "export");
    const name = tokens[i + 1];
    if (name?.kind !== "ident") {
      i++;
      continue;
    }
    // `export const p: Forall<typeof f> = …`: the annotation runs to the `=` at depth 0.
    let eq = i + 2;
    if (isPunct(tokens[eq], ":")) {
      let depth = 0;
      for (eq++; eq < tokens.length; eq++) {
        const u = tokens[eq] as Token;
        if (u.kind !== "punct") continue;
        if (opens.has(u.text) || u.text === "<") depth++;
        else if (closes.has(u.text)) depth--;
        else if (/^>+$/.test(u.text)) depth -= u.text.length;
        else if (u.text === "=" && depth === 0) break;
        if (depth < 0) break;
      }
    }
    if (!isPunct(tokens[eq], "=")) {
      i++;
      continue;
    }
    const call = combinator(eq + 1);
    if (!call) {
      i++;
      continue;
    }
    const line = lineOf(t.start);
    try {
      if (!exported) fail(`${name.text} is a spec but not exported, so nothing would check it`, t);
      if (t.text !== "const") fail(`a spec must be a const export, not ${t.text}`, t);
      let j = call.next;
      if (!isPunct(tokens[j], "(")) fail(`${call.kind} must be called`, tokens[j]);
      const callEnd = skipGroup(tokens, j);
      j++;
      const arg = functionArg(j);
      j = arg.next;
      if (call.kind === "total") {
        if (!isPunct(tokens[j], ")")) fail("total takes the function alone", tokens[j]);
        specs.push({ name: name.text, kind: "total", fn: arg.fn, text: `total(${arg.fn})`, line });
        i = callEnd;
        continue;
      }
      if (!isPunct(tokens[j], ","))
        fail("forall takes the function, then { when, ensures }", tokens[j]);
      j++;
      if (!isPunct(tokens[j], "{"))
        fail("forall's second argument must be an object literal { when, ensures }", tokens[j]);
      const objectEnd = skipGroup(tokens, j);
      j++;
      let when: Arrow | undefined;
      let ensures: Arrow | undefined;
      while (j < objectEnd - 1) {
        const key = tokens[j] as Token;
        if (isPunct(key, ",")) {
          j++;
          continue;
        }
        if (key.kind !== "ident" || (key.text !== "when" && key.text !== "ensures"))
          fail(`forall's properties are when and ensures, found ${key.text}`, key);
        if (!isPunct(tokens[j + 1], ":"))
          fail(`${key.text} must be written as ${key.text}: (…) => …`, key);
        const read = arrow(j + 2, key.text);
        if (key.text === "when") {
          if (when) fail("when is given twice", key);
          when = read.arrow;
        } else {
          if (ensures) fail("ensures is given twice", key);
          ensures = read.arrow;
        }
        j = read.next;
      }
      if (!ensures) return fail("forall needs an ensures", tokens[objectEnd - 1]);
      j = objectEnd;
      if (!isPunct(tokens[j], ")"))
        fail(`unexpected ${tokens[j]?.text ?? "end"} after forall's arguments`, tokens[j]);
      specs.push({
        name: name.text,
        kind: "forall",
        fn: arg.fn,
        ...(when ? { when } : {}),
        ensures,
        text: ensures.body.replace(/\s+/g, " ").trim(),
        line,
      });
      i = callEnd;
    } catch (err) {
      if (!(err instanceof SpecFail)) throw err;
      errors.push({ line: err.line, message: `${name.text}: ${err.message}` });
      i++;
    }
  }
  const moduleImports: ModuleImport[] = [...bound]
    .filter(
      ([, imp]) => moduleSpecifiers.has(imp.from) && imp.name !== "*" && imp.name !== "default",
    )
    .map(([local, imp]) => ({ local, name: imp.name }));
  return { specs, errors, imports: moduleImports };
}

/** Read a module and its spec file. */
export function readSpecs(input: ReadSpecsInput): ModuleSpecs {
  const moduleSide = readModuleSide(input.module);
  const specSide = readSpecSide(
    input.spec,
    new Set(input.moduleSpecifiers),
    new Set(input.specSpecifiers ?? ["eutaxy/spec", "@eutaxy/spec"]),
  );
  const errors: SpecError[] = [...moduleSide.errors, ...specSide.errors];
  // The claims' free names: the spec file's local names for the module's declarations.
  const imports = specSide.imports.flatMap((i) => {
    const fn = moduleSide.exports.get(i.name);
    return fn === undefined ? [] : [{ local: i.local, fn }];
  });
  const byFunction = new Map<string, { decl: Declaration; properties: Property[] }>();
  for (const s of specSide.specs) {
    const local = moduleSide.exports.get(s.fn);
    const decl = local === undefined ? undefined : moduleSide.declarations.get(local);
    if (!decl) {
      errors.push({
        line: s.line,
        message: `${s.name}: the module exports no function ${s.fn} whose parameters the reader can read (a function declaration or a const arrow)`,
      });
      continue;
    }
    const entry = byFunction.get(s.fn) ?? { decl, properties: [] };
    if (entry.properties.some((p) => p.name === s.name)) {
      errors.push({ line: s.line, message: `${s.name} is exported twice` });
      continue;
    }
    const hints = s.when ? hintsOf(s.when) : new Map<number, Hint>();
    const binders: Binder[] = decl.params.map((p, i) => {
      const fromEnsures = s.ensures?.params[i];
      const name = fromEnsures ?? p.name ?? `arg${i}`;
      const hint = hints.get(i);
      return { name, type: p.type, ...(hint ? { hint } : {}) };
    });
    entry.properties.push({
      name: s.name,
      kind: s.kind,
      binders,
      ...(s.when ? { when: s.when } : {}),
      ...(s.ensures ? { ensures: s.ensures } : {}),
      imports,
      text: s.text,
      line: s.line,
    });
    byFunction.set(s.fn, entry);
  }
  const functions: FunctionSpec[] = [...byFunction.entries()].map(
    ([name, { decl, properties }]) => ({
      name,
      params: decl.params,
      properties,
      line: decl.line,
      offset: decl.offset,
    }),
  );
  return { functions, errors };
}
