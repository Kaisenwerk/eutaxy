/**
 * The Lemma `@ensures` property parser: grammar.ebnf of lemma-lang, with
 * the side conditions it states on atoms. A property is a quantifier
 * prefix and a braced formula body; the body's structure (connectives,
 * equations, grouping) is Lemma, and its leaves are TypeScript expressions
 * kept verbatim. Validation that needs the enclosing module (free
 * identifiers exported) is left to whoever evaluates the leaves.
 */

import {
  type Binder,
  type Domain,
  domains,
  type Endpoint,
  type Formula,
  type Guard,
  type Property,
} from "./ir.ts";
import {
  type LemmaOp,
  type Token,
  TokenizeError,
  templateSubstitutions,
  tokenize,
} from "./tokens.ts";

/** A property that is not Lemma. `stage` says which part rejected it. */
export class LemmaSyntaxError extends Error {
  readonly stage: "prefix" | "formula";
  constructor(stage: "prefix" | "formula", message: string) {
    super(message);
    this.stage = stage;
  }
}

const numeric = new Set<Domain>(["int", "nat", "number", "bigint"]);

const literalSyntax: { readonly [d in Domain]?: RegExp } = {
  int: /^[+-]?\d[\d_]*$/,
  nat: /^[+-]?\d[\d_]*$/,
  bigint: /^[+-]?\d[\d_]*n?$/,
  number: /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$/,
};

const assignments = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);

/** Parse the text after `@ensures{name}`. Throws LemmaSyntaxError. */
export function parseProperty(text: string): Property {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (err) {
    if (err instanceof TokenizeError) throw new LemmaSyntaxError("formula", err.message);
    throw err;
  }
  const prefix = new Prefix(tokens);
  const binders = prefix.parse();
  const body = new Body(text, tokens, prefix.at);
  return { binders, ...body.parse() };
}

const isOp = (t: Token | undefined, op: LemmaOp): boolean => t?.kind === "op" && t.op === op;
const isPunct = (t: Token | undefined, p: string): boolean => t?.kind === "punct" && t.text === p;

class Prefix {
  readonly tokens: readonly Token[];
  at = 0;
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private fail(message: string): never {
    throw new LemmaSyntaxError("prefix", message);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(what: string): Token {
    const t = this.tokens[this.at++];
    if (!t) this.fail(`expected ${what}, found the end of the annotation`);
    return t;
  }

  parse(): Binder[] {
    const first = this.next("forall");
    if (isOp(first, "exists") || (first.kind === "ident" && first.text === "exists")) {
      this.fail(
        "existential quantifiers are not Lemma: sampling cannot confirm that something exists, so state the property with forall",
      );
    }
    if (!(isOp(first, "forall") || (first.kind === "ident" && first.text === "forall")))
      this.fail(`a property starts with forall, not ${JSON.stringify(first.text)}`);
    const binders: Binder[] = [];
    while (isPunct(this.peek(), "(")) binders.push(...this.group());
    if (binders.length === 0) this.fail("forall needs at least one binder group, as in (x: int)");
    const seen = new Set<string>();
    for (const b of binders) {
      if (seen.has(b.name)) this.fail(`${b.name} is bound twice`);
      seen.add(b.name);
    }
    if (!isPunct(this.peek(), "{"))
      this.fail("expected { to open the property body after the binders");
    return binders;
  }

  private group(): Binder[] {
    this.next("(");
    const names: string[] = [];
    while (this.peek()?.kind === "ident") names.push(this.next("a name").text);
    const colon = this.next(":");
    if (!isPunct(colon, ":")) {
      this.fail(
        names.length === 0
          ? "a binder group needs at least one name before the colon, as in (x: int)"
          : `expected : before the domain, found ${JSON.stringify(colon.text)}`,
      );
    }
    if (names.length === 0)
      this.fail("a binder group needs at least one name before the colon, as in (x: int)");
    for (const n of names)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
        this.fail(`${JSON.stringify(n)} is not a binder name`);
    const d = this.next("a domain");
    if (d.kind !== "ident" || !(domains as readonly string[]).includes(d.text))
      this.fail(`${JSON.stringify(d.text)} is not a Lemma domain (one of ${domains.join(", ")})`);
    const domain = d.text as Domain;
    let guard: Guard | undefined;
    const member = this.peek();
    if (isOp(member, "member") || (member?.kind === "ident" && member.text === "in")) {
      this.at++;
      guard = this.guard(domain);
    }
    const close = this.next(")");
    if (!isPunct(close, ")"))
      this.fail(`expected ) to close the binder group, found ${JSON.stringify(close.text)}`);
    return names.map((name) => ({ name, domain, ...(guard ? { guard } : {}) }));
  }

  private guard(domain: Domain): Guard {
    const t = this.peek();
    if (t?.kind === "regex") {
      this.at++;
      if (domain !== "string") this.fail(`a regex guard applies to string, not ${domain}`);
      const slash = t.text.lastIndexOf("/");
      const pattern = t.text.slice(1, slash);
      const flags = t.text.slice(slash + 1);
      if (!/^[su]*$/.test(flags) || new Set(flags).size !== flags.length)
        this.fail(`a regex guard takes only the s and u flags, not ${JSON.stringify(flags)}`);
      try {
        new RegExp(`^(?:${pattern})$`, flags);
      } catch (err) {
        this.fail(`the regex guard does not compile: ${String(err)}`);
      }
      return { kind: "regex", pattern, flags };
    }
    if (!numeric.has(domain))
      this.fail(`an interval guard applies to numeric domains only, not ${domain}`);
    const open = this.next("[ or (");
    if (!(isPunct(open, "[") || isPunct(open, "(")))
      this.fail(`expected an interval or a regex after ∈, found ${JSON.stringify(open.text)}`);
    const lower = this.endpoint(domain, isPunct(open, "["));
    const comma = this.next(",");
    if (!isPunct(comma, ","))
      this.fail(`expected , between the interval's endpoints, found ${JSON.stringify(comma.text)}`);
    const upperValue = this.endpointValue(domain);
    const close = this.next("] or )");
    if (isPunct(close, ",")) this.fail("an interval has exactly two endpoints");
    if (!(isPunct(close, "]") || isPunct(close, ")")))
      this.fail(`expected ] or ) to close the interval, found ${JSON.stringify(close.text)}`);
    const upper: Endpoint = { value: upperValue, inclusive: isPunct(close, "]") };
    this.checkInterval(domain, lower, upper);
    return { kind: "interval", lower, upper };
  }

  private endpoint(domain: Domain, inclusive: boolean): Endpoint {
    return { value: this.endpointValue(domain), inclusive };
  }

  private endpointValue(domain: Domain): string {
    let sign = "";
    const s = this.peek();
    if (isPunct(s, "-") || isPunct(s, "+")) {
      this.at++;
      sign = s?.text === "-" ? "-" : "";
    }
    const t = this.next("an endpoint");
    if (isOp(t, "infinity") || (t.kind === "ident" && t.text === "Infinity")) return `${sign}∞`;
    if (t.kind !== "number") this.fail(`${JSON.stringify(t.text)} is not an interval endpoint`);
    const value = `${sign}${t.text}`;
    const syntax = literalSyntax[domain];
    if (syntax && !syntax.test(value)) this.fail(`${value} is not a ${domain} literal`);
    return value;
  }

  private checkInterval(domain: Domain, lower: Endpoint, upper: Endpoint): void {
    const integral = domain !== "number";
    for (const e of [lower, upper])
      if (e.value.endsWith("∞") && e.inclusive && integral)
        this.fail(`an ∞ endpoint must be exclusive for ${domain}`);
    if (lower.value === "∞") this.fail("the lower endpoint cannot be +∞");
    if (upper.value === "-∞") this.fail("the upper endpoint cannot be -∞");
    // Integer literals compare exactly (a double would merge neighbours beyond 2^53).
    const exact = (v: string): number | bigint =>
      integral && !v.endsWith("∞")
        ? BigInt(v.replace(/_/g, "").replace(/n$/, ""))
        : endpointNumber(v);
    const lo = exact(lower.value);
    const hi = exact(upper.value);
    if (lo > hi || (lo === hi && !(lower.inclusive && upper.inclusive)))
      this.fail(`the interval from ${lower.value} to ${upper.value} is empty`);
  }
}

/** An endpoint's value for ordering: exact for integer literals, as a double otherwise. */
export function endpointNumber(value: string): number {
  if (value === "∞") return Number.POSITIVE_INFINITY;
  if (value === "-∞") return Number.NEGATIVE_INFINITY;
  return Number(value.replace(/_/g, "").replace(/n$/, ""));
}

const connectives = new Set<LemmaOp>(["and", "or", "not", "implies", "iff"]);

class Body {
  private readonly text: string;
  private readonly tokens: readonly Token[];
  private readonly open: number;
  /** Per token of the body: how many brackets enclose it inside the body braces. */
  private readonly depth = new Map<number, number>();
  /** Bracket matches, both ways. */
  private readonly match = new Map<number, number>();
  /** Per token: the innermost enclosing opening bracket, or -1. */
  private readonly enclosing = new Map<number, number>();

  constructor(text: string, tokens: readonly Token[], open: number) {
    this.text = text;
    this.tokens = tokens;
    this.open = open;
  }

  private fail(message: string): never {
    throw new LemmaSyntaxError("formula", message);
  }

  parse(): { requires: Formula[]; claim: Formula } {
    const pairs: { [close: string]: string } = { ")": "(", "]": "[", "}": "{" };
    const stack: number[] = [];
    let close = -1;
    for (let i = this.open; i < this.tokens.length; i++) {
      const t = this.tokens[i] as Token;
      this.depth.set(i, stack.length - 1);
      this.enclosing.set(i, stack[stack.length - 1] ?? -1);
      if (t.kind !== "punct") continue;
      if (t.text === "(" || t.text === "[" || t.text === "{") stack.push(i);
      else if (pairs[t.text]) {
        const o = stack.pop();
        if (o === undefined || this.tokens[o]?.text !== pairs[t.text])
          this.fail(`unbalanced ${t.text} in the property body`);
        this.match.set(o, i);
        this.match.set(i, o);
        if (stack.length === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) this.fail("the property body is not closed with }");
    if (close !== this.tokens.length - 1)
      this.fail("the } closing the property body must be the annotation's last token");
    const s = this.open + 1;
    const e = close;
    if (s >= e) this.fail("the property body is empty");
    const grouped = isPunct(this.tokens[s], "(") && this.match.get(s) === e - 1;
    const f = this.formula(s, e, 0);
    if (!grouped && f.kind === "implies")
      return { requires: [...f.antecedents], claim: f.consequent };
    return { requires: [], claim: f };
  }

  private at(i: number, base: number): boolean {
    return this.depth.get(i) === base;
  }

  /** Base-level positions of tokens satisfying `pred` in [s, e). */
  private split(
    s: number,
    e: number,
    base: number,
    pred: (t: Token, i: number) => boolean,
  ): number[] {
    const out: number[] = [];
    for (let i = s; i < e; i++)
      if (this.at(i, base) && pred(this.tokens[i] as Token, i)) out.push(i);
    return out;
  }

  private segments(s: number, e: number, cuts: readonly number[]): [number, number][] {
    const out: [number, number][] = [];
    let from = s;
    for (const c of cuts) {
      out.push([from, c]);
      from = c + 1;
    }
    out.push([from, e]);
    return out;
  }

  private formula(s: number, e: number, base: number): Formula {
    if (s >= e) this.fail("a connective is missing an operand");
    // The word iff is the connective, except as a member name (`api.iff`).
    const iff = this.split(s, e, base, (t, i) => {
      if (t.op === "iff") return true;
      const prev = this.tokens[i - 1];
      return t.kind === "ident" && t.text === "iff" && !isPunct(prev, ".") && !isPunct(prev, "?.");
    });
    if (iff.length > 1) this.fail("↔ is non-associative: parenthesize a ↔ b ↔ c");
    if (iff.length === 1) {
      const k = iff[0] as number;
      return { kind: "iff", left: this.formula(s, k, base), right: this.formula(k + 1, e, base) };
    }
    const implies = this.split(s, e, base, (t) => t.op === "implies");
    if (implies.length > 0) {
      const parts = this.segments(s, e, implies).map(([a, b]) => this.formula(a, b, base));
      return {
        kind: "implies",
        antecedents: parts.slice(0, -1),
        consequent: parts[parts.length - 1] as Formula,
      };
    }
    for (const kind of ["or", "and"] as const) {
      const cuts = this.split(s, e, base, (t) => t.op === kind);
      if (cuts.length > 0)
        return {
          kind,
          operands: this.segments(s, e, cuts).map(([a, b]) => this.formula(a, b, base)),
        };
    }
    if (isOp(this.tokens[s], "not")) return { kind: "not", operand: this.formula(s + 1, e, base) };
    if (isPunct(this.tokens[s], "(") && this.match.get(s) === e - 1)
      return this.formula(s + 1, e - 1, base + 1);
    return this.atom(s, e, base);
  }

  private slice(s: number, e: number): string {
    return this.text
      .slice((this.tokens[s] as Token).start, (this.tokens[e - 1] as Token).end)
      .trim();
  }

  private atom(s: number, e: number, base: number): Formula {
    const equations: number[] = [];
    for (let i = s; i < e; i++) {
      const t = this.tokens[i] as Token;
      const prev = i > s ? this.tokens[i - 1] : undefined;
      this.checkToken(t, prev);
      if (t.kind === "op") {
        if (t.op === "equiv" || t.op === "nequiv") {
          if (!this.at(i, base))
            this.fail(
              `${t.text} only joins an atom's two sides; in nested positions call Object.is`,
            );
          equations.push(i);
        } else if (connectives.has(t.op as LemmaOp))
          this.fail(
            `${t.text} inside a JavaScript expression: use && || ! there, or parenthesize the whole formula`,
          );
        else this.fail(`${t.text} belongs in a binder group, not the property body`);
      }
      if (t.kind !== "punct") continue;
      if (assignments.has(t.text) && !this.inParameterList(i))
        this.fail(`assignments are not allowed in a property (${t.text})`);
      if (!this.at(i, base)) continue;
      if (t.text === "&&" || t.text === "||")
        this.fail(`${t.text} at an atom's top level: use ${t.text === "&&" ? "∧" : "∨"}`);
      if (t.text === "!" && !endsOperand(prev)) this.fail("prefix ! at an atom's top level: use ¬");
    }
    if (equations.length > 1) this.fail("≡ is non-associative: write a ≡ b ∧ b ≡ c");
    if (equations.length === 0) return { kind: "atom", text: this.slice(s, e) };
    const k = equations[0] as number;
    for (let i = s; i < e; i++) {
      const t = this.tokens[i] as Token;
      if (
        this.at(i, base) &&
        t.kind === "punct" &&
        ["??", "?", "===", "!==", ",", "=>"].includes(t.text)
      )
        this.fail(`${t.text} beside an equation is ambiguous: parenthesize the side it belongs to`);
    }
    if (k === s || k === e - 1)
      this.fail(`${this.tokens[k]?.text} needs an expression on both sides`);
    return {
      kind: "equation",
      left: this.slice(s, k),
      right: this.slice(k + 1, e),
      negated: this.tokens[k]?.op === "nequiv",
    };
  }

  /**
   * What no position in a property allows, for one token of an atom or of
   * an expression nested in one: ≠, quantifiers, loose equality; a
   * template's substitutions are nested expressions under the same rules.
   */
  private checkToken(t: Token, prev: Token | undefined): void {
    if (t.kind === "op") {
      if (t.op === "neq") this.fail("≠ is not Lemma: write ≢ (not the same value) or !==");
      if (t.op === "forall" || t.op === "exists") this.fail("quantifiers nest only in the prefix");
    }
    if (
      t.kind === "ident" &&
      (t.text === "forall" || t.text === "exists") &&
      !isPunct(prev, ".") &&
      !isPunct(prev, "?.")
    )
      this.fail("quantifiers nest only in the prefix");
    if (t.kind === "template") for (const sub of templateSubstitutions(t.text)) this.nested(sub);
    if (t.kind === "punct" && (t.text === "==" || t.text === "!="))
      this.fail(`loose ${t.text} is not allowed: use ≡ / ≢ or === / !==`);
  }

  /** Check an expression nested in an atom (a template substitution): what no position allows. */
  private nested(text: string): void {
    let tokens: Token[];
    try {
      tokens = tokenize(text);
    } catch (err) {
      if (err instanceof TokenizeError) this.fail(err.message);
      throw err;
    }
    const stack: number[] = [];
    const enclosing: number[] = [];
    const match = new Map<number, number>();
    tokens.forEach((t, i) => {
      enclosing.push(stack[stack.length - 1] ?? -1);
      if (t.kind !== "punct") return;
      if (t.text === "(" || t.text === "[" || t.text === "{") stack.push(i);
      else if (t.text === ")" || t.text === "]" || t.text === "}") {
        const o = stack.pop();
        if (o !== undefined) match.set(o, i);
      }
    });
    tokens.forEach((t, i) => {
      this.checkToken(t, tokens[i - 1]);
      if (t.kind === "op") {
        if (t.op === "equiv" || t.op === "nequiv")
          this.fail(`${t.text} only joins an atom's two sides; in nested positions call Object.is`);
        this.fail(
          `${t.text} inside a JavaScript expression: use && || ! there, or parenthesize the whole formula`,
        );
      }
      if (t.kind !== "punct") return;
      if (assignments.has(t.text)) {
        const open = enclosing[i] ?? -1;
        const close = open >= 0 ? match.get(open) : undefined;
        const defaultValue =
          t.text === "=" &&
          isPunct(tokens[open], "(") &&
          close !== undefined &&
          isPunct(tokens[close + 1], "=>");
        if (!defaultValue) this.fail(`assignments are not allowed in a property (${t.text})`);
      }
    });
  }

  /** A default initializer: `=` directly inside the parentheses of an arrow function's parameters. */
  private inParameterList(i: number): boolean {
    if (this.tokens[i]?.text !== "=") return false;
    const open = this.enclosing.get(i) ?? -1;
    if (open < 0 || !isPunct(this.tokens[open], "(")) return false;
    const close = this.match.get(open);
    return close !== undefined && isPunct(this.tokens[close + 1], "=>");
  }
}

/** Whether a token ends an operand, so a `!` after it is postfix (non-null assertion). */
function endsOperand(t: Token | undefined): boolean {
  if (!t) return false;
  if (t.kind === "punct") return t.text === ")" || t.text === "]" || t.text === "}";
  return t.kind !== "op";
}
