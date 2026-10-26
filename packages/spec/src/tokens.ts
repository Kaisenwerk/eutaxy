/**
 * A tokenizer shaped like TypeScript's scanner, which is how Lemma
 * tokenizes an annotation: glyphs inside string, template and regex
 * literals are text, never operators, and a template substitution nests.
 * It knows Lemma's operators besides JavaScript's punctuators; which ones
 * count where is the parser's business.
 */

export type TokenKind =
  | "ident"
  | "number"
  | "string"
  | "template"
  | "regex"
  | "punct"
  | "op"
  | "comment";

/** Lemma operators, by canonical name. */
export type LemmaOp =
  | "and"
  | "or"
  | "not"
  | "implies"
  | "iff"
  | "equiv"
  | "nequiv"
  | "neq"
  | "forall"
  | "exists"
  | "member"
  | "infinity";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Offsets into the scanned text: [start, end). */
  readonly start: number;
  readonly end: number;
  /** For kind "op". */
  readonly op?: LemmaOp;
}

const glyphs: { readonly [glyph: string]: LemmaOp } = {
  "∧": "and",
  "∨": "or",
  "¬": "not",
  "→": "implies",
  "↔": "iff",
  "≡": "equiv",
  "≢": "nequiv",
  "≠": "neq",
  "∀": "forall",
  "∃": "exists",
  "∈": "member",
  "∞": "infinity",
};

/** ASCII spellings of Lemma connectives, longest first. */
const asciiOps: readonly (readonly [string, LemmaOp])[] = [
  ["<->", "iff"],
  ["==>", "implies"],
  ["->", "implies"],
  ["\\/", "or"],
];

const punctuators = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const regexAfter = new Set([
  "in",
  "of",
  "typeof",
  "instanceof",
  "return",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const identStart = /[\p{ID_Start}$_]/u;
const identPart = /[\p{ID_Continue}$‌‍]/u;
const numberAt =
  /^(?:0[xXoObB][0-9a-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/;

export class TokenizeError extends Error {}

/** Keywords whose parenthesized condition is followed by a statement, not an operator. */
const controlKeywords = new Set(["if", "while", "for", "with"]);

/**
 * Whether the code tokens up to `k` end an operand, so a `/` after them
 * divides. `conditions` holds the `)` that close a control statement's
 * condition (`if (x) /re/.test(s)`), after which a statement starts.
 */
function endsOperand(
  tokens: readonly Token[],
  k: number,
  conditions: ReadonlySet<number>,
  blocks: ReadonlySet<number>,
): boolean {
  while (k >= 0 && tokens[k]?.kind === "comment") k--;
  const t = tokens[k];
  if (!t) return false;
  switch (t.kind) {
    case "ident": {
      // After `.`, a word is a member name, whatever its spelling (`obj.in`).
      const before = tokens.slice(0, k).findLast((u) => u.kind !== "comment");
      if (before?.kind === "punct" && (before.text === "." || before.text === "?.")) return true;
      return !regexAfter.has(t.text);
    }
    case "punct":
      // After an operand, `!` (TypeScript's non-null assertion), `++` and `--` are postfix and end one too.
      if (t.text === "!" || t.text === "++" || t.text === "--")
        return endsOperand(tokens, k - 1, conditions, blocks);
      if (t.text === ")") return !conditions.has(k);
      // A `}` closing a statement block ends no expression; one closing an object literal does.
      if (t.text === "}") return !blocks.has(k);
      return t.text === "]";
    case "op":
      return false;
    default:
      return true;
  }
}

/** The end of a quoted string starting at `i`. */
function endOfString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === quote) return j + 1;
    else if (c === "\n") break;
  }
  throw new TokenizeError(`unterminated string at offset ${i}`);
}

/** The end of the template literal starting at `i`, substitutions included. */
function endOfTemplate(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "`") return j + 1;
    else if (c === "$" && text[j + 1] === "{") j = endOfSubstitution(text, j + 2) - 1;
  }
  throw new TokenizeError(`unterminated template literal at offset ${i}`);
}

/** The offset just past the `}` that closes a substitution whose body starts at `i`, scanned as code. */
function endOfSubstitution(text: string, i: number): number {
  return scan(text, i, { untilBrace: true }).end;
}

/** The source of each `${…}` substitution in a template literal's text, outermost only. */
export function templateSubstitutions(template: string): string[] {
  const out: string[] = [];
  for (let j = 1; j < template.length; j++) {
    const c = template[j];
    if (c === "\\") j++;
    else if (c === "$" && template[j + 1] === "{") {
      const end = endOfSubstitution(template, j + 2);
      out.push(template.slice(j + 2, end - 1));
      j = end - 1;
    }
  }
  return out;
}

/** The end of the regex literal starting at `i`, flags included. */
function endOfRegex(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "\n") break;
    else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") inClass = true;
    else if (c === "/") {
      let k = j + 1;
      while (k < text.length && identPart.test(text[k] as string)) k++;
      return k;
    }
  }
  throw new TokenizeError(`unterminated regular expression at offset ${i}`);
}

/** Tokens of `text`; comments are dropped unless `comments` is set (then they are "comment" tokens). */
export function tokenize(text: string, options: { readonly comments?: boolean } = {}): Token[] {
  return scan(text, 0, options).tokens;
}

/**
 * Scan from `start`. With `untilBrace`, stop after the `}` that closes an
 * enclosing substitution (one not opened in the scanned code) and return
 * the offset after it.
 */
function scan(
  text: string,
  start: number,
  options: { readonly comments?: boolean; readonly untilBrace?: boolean },
): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, start: number, end: number, op?: LemmaOp): void => {
    tokens.push({ kind, text: text.slice(start, end), start, end, ...(op ? { op } : {}) });
  };
  // Comments are always tracked here, so regex detection can skip them; they are dropped at the end if unwanted.
  let braces = 0;
  // Open parentheses (true for a control statement's condition), and the `)` that closed a condition.
  const parens: boolean[] = [];
  const conditions = new Set<number>();
  // Open braces (true for a statement block), and the `}` that closed a block.
  const curlies: boolean[] = [];
  const blocks = new Set<number>();
  let i = start;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      // A line comment ends at any JavaScript line terminator, not only LF: code after a CR or a
      // U+2028/U+2029 is code.
      const from = i;
      while (i < text.length && !/[\n\r\u2028\u2029]/u.test(text[i] as string)) i++;
      push("comment", from, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) throw new TokenizeError(`unterminated comment at offset ${i}`);
      push("comment", i, close + 2);
      i = close + 2;
      continue;
    }
    const glyph = glyphs[c];
    if (glyph) {
      push("op", i, i + 1, glyph);
      i++;
      continue;
    }
    const ascii = asciiOps.find(([s]) => text.startsWith(s, i));
    if (ascii) {
      push("op", i, i + ascii[0].length, ascii[1]);
      i += ascii[0].length;
      continue;
    }
    if (c === "/") {
      if (!endsOperand(tokens, tokens.length - 1, conditions, blocks)) {
        const end = endOfRegex(text, i);
        push("regex", i, end);
        i = end;
        continue;
      }
      if (text[i + 1] === "\\") {
        push("op", i, i + 2, "and");
        i += 2;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      const end = endOfTemplate(text, i);
      push("template", i, end);
      i = end;
      continue;
    }
    const num = numberAt.exec(text.slice(i));
    if (num && (/\d/.test(c) || (c === "." && /\d/.test(text[i + 1] ?? "")))) {
      push("number", i, i + num[0].length);
      i += num[0].length;
      continue;
    }
    if (identStart.test(c)) {
      let j = i + 1;
      while (j < text.length && identPart.test(text[j] as string)) j++;
      // Words (`forall`, `in`, `iff`, ...) stay identifiers: whether they are Lemma's depends on where.
      push("ident", i, j);
      i = j;
      continue;
    }
    const p = punctuators.find((s) => text.startsWith(s, i)) ?? c;
    if (p === "(") {
      const before = tokens.findLast((t) => t.kind !== "comment");
      parens.push(before?.kind === "ident" && controlKeywords.has(before.text));
    } else if (p === ")" && parens.pop()) conditions.add(tokens.length);
    if (p === "{") {
      const before = tokens.findLast((t) => t.kind !== "comment");
      curlies.push(
        before === undefined ||
          (before.kind === "punct" && [")", "{", "}", ";", "=>"].includes(before.text)) ||
          (before.kind === "ident" && ["else", "do", "try", "finally"].includes(before.text)),
      );
    } else if (p === "}" && curlies.pop()) blocks.add(tokens.length);
    if (p === "{") braces++;
    if (p === "}" && braces-- === 0 && options.untilBrace) {
      return { tokens: keep(tokens, options), end: i + 1 };
    }
    push("punct", i, i + p.length);
    i += p.length;
  }
  if (options.untilBrace)
    throw new TokenizeError(`unterminated template substitution at offset ${start}`);
  return { tokens: keep(tokens, options), end: i };
}

function keep(tokens: Token[], options: { readonly comments?: boolean }): Token[] {
  return options.comments ? tokens : tokens.filter((t) => t.kind !== "comment");
}
