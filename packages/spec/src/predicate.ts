/**
 * A property as TypeScript source: an arrow function from the binders to
 * "held", "discarded" (a precondition failed, so the assignment is outside
 * the claim) or "refuted". Atoms are the islands as written, each checked to
 * be a genuine boolean by a helper the surrounding module defines; `≡` is
 * `Object.is`. The source is code to compile, not to `eval`: runtimes such
 * as workerd refuse dynamic code.
 */

import type { Domain, Formula, Property } from "./ir.ts";
import { type Token, templateSubstitutions, tokenize } from "./tokens.ts";

/** The outcome a predicate returns for one assignment. */
export type PredicateOutcome = "held" | "discarded" | "refuted";

const tsType: { readonly [d in Domain]: string } = {
  int: "number",
  nat: "number",
  number: "number",
  boolean: "boolean",
  string: "string",
  bigint: "bigint",
};

/** Names in the surrounding generated module that the predicate's source refers to. */
export interface PredicateHelpers {
  /** Returns its argument when it is a boolean, throws a TypeError otherwise. */
  readonly bool: string;
  /** `Object.is`. */
  readonly same: string;
  /** The annotated module's namespace: where a property's free identifiers come from. */
  readonly scope: string;
  /** Throws for the free names that neither the namespace nor the globals define. */
  readonly unresolved: string;
}

/** Words that cannot name a binding. */
const reserved = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval".split(
    " ",
  ),
);

function islands(f: Formula): string[] {
  switch (f.kind) {
    case "atom":
      return [f.text];
    case "equation":
      return [f.left, f.right];
    case "not":
      return islands(f.operand);
    case "and":
    case "or":
      return f.operands.flatMap(islands);
    case "implies":
      return [...f.antecedents, f.consequent].flatMap(islands);
    case "iff":
      return [...islands(f.left), ...islands(f.right)];
  }
}

/** Names an arrow function binds, over the tokens of its parameters and body. */
interface ArrowScope {
  readonly names: ReadonlySet<string>;
  readonly from: number;
  readonly to: number;
}

/**
 * Indices of the tokens that are TypeScript type positions or binding
 * names, not references, and the scopes arrow functions bind names in.
 */
function notReferences(tokens: readonly Token[]): { skip: Set<number>; scopes: ArrowScope[] } {
  const skip = new Set<number>();
  const scopes: ArrowScope[] = [];
  const match = new Map<number, number>();
  const stack: number[] = [];
  /** Per token, the innermost open bracket around it, or -1. */
  const enclosing: number[] = [];
  tokens.forEach((t, i) => {
    enclosing.push(stack[stack.length - 1] ?? -1);
    if (t.kind !== "punct") return;
    if (t.text === "(" || t.text === "[" || t.text === "{") stack.push(i);
    else if (t.text === ")" || t.text === "]" || t.text === "}") {
      const o = stack.pop();
      if (o !== undefined) match.set(o, i);
    }
  });
  const is = (k: number, text: string) => tokens[k]?.kind === "punct" && tokens[k]?.text === text;
  /** The last token of an arrow body starting at `k`: a block, or an expression up to a top-level `,` or close. */
  const bodyEnd = (k: number): number => {
    if (is(k, "{")) return match.get(k) ?? tokens.length - 1;
    let depth = 0;
    for (let m = k; m < tokens.length; m++) {
      const u = tokens[m] as Token;
      if (u.kind !== "punct") continue;
      if (u.text === "(" || u.text === "[" || u.text === "{") depth++;
      else if (u.text === ")" || u.text === "]" || u.text === "}") {
        if (depth === 0) return m - 1;
        depth--;
      } else if (u.text === "," && depth === 0) return m - 1;
    }
    return tokens.length - 1;
  };
  /**
   * The index just after a type starting at `k`: names, dots, brackets,
   * unions and intersections, and type arguments, but a `<` only when its
   * `>` closes before anything that cannot be in a type (else it compares).
   */
  const typeEnd = (k: number): number => {
    const typeish = (u: Token | undefined, angles: number) =>
      u !== undefined &&
      (u.kind === "ident" ||
        u.kind === "string" ||
        u.kind === "number" ||
        (u.kind === "punct" && [".", "[", "]", "|", "&"].includes(u.text)) ||
        (angles > 0 &&
          u.kind === "punct" &&
          [",", "(", ")", "=>", ":", "{", "}", ";"].includes(u.text)));
    let m = k;
    while (m < tokens.length) {
      const u = tokens[m] as Token;
      if (u.kind === "punct" && u.text === "<") {
        let angles = 0;
        let n = m;
        for (; n < tokens.length; n++) {
          const w = tokens[n] as Token;
          if (w.kind === "punct" && w.text === "<") angles++;
          else if (w.kind === "punct" && /^>+$/.test(w.text)) {
            angles -= w.text.length;
            if (angles <= 0) break;
          } else if (!typeish(w, angles)) break;
        }
        if (angles > 0 || n >= tokens.length || !/^>+$/.test((tokens[n] as Token).text)) return m;
        m = n + 1;
        continue;
      }
      if (!typeish(u, 0)) return m;
      m++;
    }
    return m;
  };
  /** After the `)` of a parameter list at `close`: an optional `: ReturnType`, then the index of what follows. */
  const afterReturnType = (close: number): number => {
    if (!is(close + 1, ":")) return close + 1;
    const end = typeEnd(close + 2);
    for (let m = close + 2; m < end; m++) skip.add(m);
    return end;
  };
  /**
   * The names a parameter list from `open` to `close` binds, skipping them and
   * their type annotations. A `:` directly in the list starts a type; inside a
   * destructuring pattern it renames (`{ a: b }` binds b).
   */
  const parameters = (open: number, close: number): Set<string> => {
    const names = new Set<string>();
    const nesting: string[] = [];
    let inType = false;
    // Inside a default value (`v = limit`, `{ a = f(b) }`): references, not names, until it ends.
    let inDefault = false;
    let defaultDepth = 0;
    for (let k = open + 1; k < close; k++) {
      const u = tokens[k] as Token;
      if (inDefault) {
        if (u.kind !== "punct") continue;
        if (u.text === "(" || u.text === "[" || u.text === "{") {
          defaultDepth++;
          continue;
        }
        if ((u.text === ")" || u.text === "]" || u.text === "}") && defaultDepth > 0) {
          defaultDepth--;
          continue;
        }
        if (
          defaultDepth > 0 ||
          !(u.text === "," || u.text === ")" || u.text === "]" || u.text === "}")
        )
          continue;
        inDefault = false; // The default ends at a `,` or the pattern's close, handled below.
      }
      if (u.kind === "punct") {
        if (!inType && u.text === "=") {
          inDefault = true;
          defaultDepth = 0;
          continue;
        }
        if (inType) {
          if (u.text === "(" || u.text === "[" || u.text === "{" || u.text === "<")
            nesting.push(u.text);
          else if (nesting.length > 0 && [")", "]", "}"].includes(u.text)) nesting.pop();
          else if (nesting.length > 0 && /^>+$/.test(u.text)) nesting.splice(-u.text.length);
          else if (nesting.length === 0 && u.text === ",") inType = false;
          else if (nesting.length === 0 && u.text === "=") {
            inType = false;
            inDefault = true;
            defaultDepth = 0;
          }
          continue;
        }
        if (u.text === "{" || u.text === "[") nesting.push(u.text);
        else if (u.text === "}" || u.text === "]") nesting.pop();
        else if (u.text === ":" && nesting.length === 0) inType = true;
        continue;
      }
      if (inType) {
        skip.add(k);
        continue;
      }
      if (u.kind !== "ident") continue;
      const prev = tokens[k - 1];
      const next = tokens[k + 1];
      // In a pattern, a key followed by `:` is renamed; the name after the `:` is bound.
      if (nesting.length > 0 && next?.kind === "punct" && next.text === ":") {
        skip.add(k);
        continue;
      }
      if (prev?.kind === "punct" && ["(", ",", "...", "{", "[", ":"].includes(prev.text)) {
        names.add(u.text);
        skip.add(k);
      }
    }
    return names;
  };
  tokens.forEach((t, i) => {
    if (t.kind === "ident" && is(i + 1, "=>")) {
      skip.add(i); // x => …
      scopes.push({ names: new Set([t.text]), from: i, to: bodyEnd(i + 2) });
    }
    const close = is(i, "(") ? match.get(i) : undefined;
    const arrow = close === undefined ? -1 : afterReturnType(close);
    if (close !== undefined && is(arrow, "=>")) {
      scopes.push({ names: parameters(i, close), from: i, to: bodyEnd(arrow + 1) });
    }
    if (t.kind === "ident" && is(i + 1, "(") && (is(i - 1, "{") || is(i - 1, ","))) {
      // { name(a) { … } }: an object method, named like a key, binding its parameters in its body.
      const end = match.get(i + 1);
      const body = end === undefined ? -1 : afterReturnType(end);
      if (end !== undefined && is(body, "{")) {
        skip.add(i);
        scopes.push({
          names: parameters(i + 1, end),
          from: i + 1,
          to: match.get(body) ?? tokens.length - 1,
        });
      }
    }
    if (t.kind === "ident" && t.text === "for" && is(i + 1, "(")) {
      // for (const y of xs) …, for (const k in o) …: the head's names are the loop's.
      const end = match.get(i + 1);
      const decl = tokens[i + 2];
      if (
        end !== undefined &&
        decl?.kind === "ident" &&
        ["const", "let", "var"].includes(decl.text)
      ) {
        const names = new Set<string>();
        for (let k = i + 3; k < end; k++) {
          const u = tokens[k] as Token;
          if (u.kind === "ident" && (u.text === "of" || u.text === "in")) {
            skip.add(k);
            break;
          }
          if (u.kind === "ident" && !is(k + 1, ":")) {
            names.add(u.text);
            skip.add(k);
          }
        }
        const body = end + 1;
        const to = is(body, "{") ? (match.get(body) ?? tokens.length - 1) : bodyEnd(body);
        scopes.push({ names, from: i, to });
      }
    }
    if (t.kind === "ident" && t.text === "catch" && is(i + 1, "(")) {
      // catch (err) { … }: the binding is the following block's.
      const end = match.get(i + 1);
      if (end !== undefined && is(end + 1, "{"))
        scopes.push({
          names: parameters(i + 1, end),
          from: i + 1,
          to: match.get(end + 1) ?? tokens.length - 1,
        });
    }
    if (t.kind === "ident" && t.text === "function") {
      // function [name](a, b) { … }: its parameters are bound in it. A declaration (in statement
      // position) binds its name in the enclosing block; an expression's name only in itself.
      const named = tokens[i + 1]?.kind === "ident";
      const statement = i === 0 || ["{", "}", ";"].some((p) => is(i - 1, p));
      if (named && statement) {
        const open = enclosing[i] ?? -1;
        skip.add(i + 1);
        scopes.push({
          names: new Set([(tokens[i + 1] as Token).text]),
          from: open,
          to: open >= 0 ? (match.get(open) ?? tokens.length - 1) : tokens.length - 1,
        });
      }
      const open = named ? i + 2 : i + 1;
      const end = is(open, "(") ? match.get(open) : undefined;
      const body = end === undefined ? -1 : afterReturnType(end);
      if (end !== undefined && is(body, "{")) {
        const names = parameters(open, end);
        if (named) {
          names.add((tokens[i + 1] as Token).text);
          skip.add(i + 1);
        }
        scopes.push({ names, from: i, to: match.get(body) ?? tokens.length - 1 });
      }
    }
    if (t.kind === "ident" && is(i + 1, ":") && (is(i - 1, "{") || is(i - 1, ","))) skip.add(i); // { key: … }
    if (t.kind === "ident" && (t.text === "as" || t.text === "satisfies")) {
      // The operator and the type after it.
      skip.add(i);
      for (let k = i + 1; k < typeEnd(i + 1); k++) skip.add(k);
    }
    if (t.kind === "ident" && is(i + 1, "<")) {
      // f<A, B>(…): a generic call's type arguments, only when they read as a type and a call follows.
      const end = typeEnd(i + 1);
      if (end > i + 1 && is(end, "(")) for (let m = i + 2; m < end; m++) skip.add(m);
    }
  });
  return { skip, scopes };
}

/**
 * Identifiers the islands refer to from outside: not after a `.`, not a
 * binder, not an object key, an arrow function's parameter or a type. What
 * is left may still over-approximate (a `function` expression's parameter),
 * which only costs a binding the inner name shadows.
 */
export function freeNames(p: Property): string[] {
  const bound = new Set(p.binders.map((b) => b.name));
  const names = new Set<string>();
  // `outer`: names bound where the text sits, for a template substitution inside an arrow.
  const scan = (text: string, outer: ReadonlySet<string>): void => {
    const tokens = tokenize(text);
    const { skip, scopes } = notReferences(tokens);
    // A name an arrow function binds is its own inside that function.
    const local = (n: string, i: number) =>
      scopes.some((sc) => sc.names.has(n) && sc.from <= i && i <= sc.to);
    tokens.forEach((t, i) => {
      // A template's substitutions are expressions too.
      if (t.kind === "template") {
        const inScope = new Set(outer);
        for (const sc of scopes)
          if (sc.from <= i && i <= sc.to) for (const n of sc.names) inScope.add(n);
        for (const sub of templateSubstitutions(t.text)) scan(sub, inScope);
      }
      const prev = tokens[i - 1];
      if (
        t.kind !== "ident" ||
        skip.has(i) ||
        bound.has(t.text) ||
        reserved.has(t.text) ||
        outer.has(t.text) ||
        local(t.text, i)
      )
        return;
      if (prev?.kind === "punct" && (prev.text === "." || prev.text === "?.")) return;
      names.add(t.text);
    });
  };
  for (const text of [...p.requires, p.claim].flatMap(islands)) scan(text, new Set());
  return [...names];
}

function expression(f: Formula, h: { bool: string; same: string }): string {
  switch (f.kind) {
    case "atom":
      return `${h.bool}((${f.text}))`;
    case "equation":
      return `${f.negated ? "!" : ""}${h.same}((${f.left}), (${f.right}))`;
    case "not":
      return `!${expression(f.operand, h)}`;
    case "and":
    case "or":
      return `(${f.operands.map((o) => expression(o, h)).join(f.kind === "and" ? " && " : " || ")})`;
    case "implies":
      return `(!(${f.antecedents.map((a) => expression(a, h)).join(" && ")}) || ${expression(f.consequent, h)})`;
    case "iff":
      return `(${expression(f.left, h)} === ${expression(f.right, h)})`;
  }
}

/**
 * The predicate's source: an expression evaluating to the arrow function.
 * It takes the helpers as parameters under names fresh for this property,
 * so no binder or identifier in it can shadow them, and binds each free
 * name from the module's namespace when it has it, else from the globals,
 * which is the scope Lemma gives a property (re-exports included).
 */
export function predicateSource(p: Property, helpers: PredicateHelpers): string {
  // The globals that name fixed values, and `globalThis` itself, are never rebound.
  const free = freeNames(p).filter(
    (n) => !["globalThis", "undefined", "NaN", "Infinity"].includes(n),
  );
  const taken = new Set([...p.binders.map((b) => b.name), ...free, "globalThis"]);
  const fresh = (base: string): string => {
    let name = base;
    while (taken.has(name)) name = `${name}$`;
    taken.add(name);
    return name;
  };
  const local = {
    bool: fresh("__bool"),
    same: fresh("__same"),
    scope: fresh("__scope"),
    unresolved: fresh("__unresolved"),
    missing: fresh("__missing"),
  };
  const params = p.binders.map((b) => `${b.name}: ${tsType[b.domain]}`).join(", ");
  const lines = [
    `((${local.bool}: (v: unknown) => boolean, ${local.same}: (a: unknown, b: unknown) => boolean, ${local.scope}: any, ${local.unresolved}: (names: string[]) => never) => {`,
    `  const ${local.missing}: string[] = [];`,
    // A name the module does not have comes from the globals (`globalThis` itself is never rebound);
    // one neither defines is noted, and evaluating the property then throws rather than reading undefined.
    ...free.map((n) => {
      const k = JSON.stringify(n);
      return `  const ${n} = ${k} in ${local.scope} ? ${local.scope}[${k}] : ${k} in globalThis ? (globalThis as any)[${k}] : (${local.missing}.push(${k}), undefined);`;
    }),
    `  return (${params}): "held" | "discarded" | "refuted" => {`,
    `    if (${local.missing}.length > 0) ${local.unresolved}(${local.missing});`,
    ...p.requires.map((r) => `    if (!${expression(r, local)}) return "discarded";`),
    `    return ${expression(p.claim, local)} ? "held" : "refuted";`,
    "  };",
    `})(${helpers.bool}, ${helpers.same}, ${helpers.scope}, ${helpers.unresolved})`,
  ];
  return lines.join("\n");
}
