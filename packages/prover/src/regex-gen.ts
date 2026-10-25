/**
 * Strings that match a regular expression, drawn with core's seeded
 * generator: the pattern is parsed into alternatives, sequences, classes
 * and quantified terms, and each draw walks that tree. The subset is what
 * guards use: literals, escapes, classes with ranges and negation, groups,
 * alternation, the usual quantifiers and anchors. Lookaround,
 * backreferences and Unicode property escapes are refused with
 * `UnsupportedRegex`, and the caller falls back to sampling. Every draw is
 * checked against the real `RegExp` by the caller, so a gap here can only
 * cost a draw, never admit a value outside the guard.
 */

import { nextInt, type PrngState } from "@eutaxy/core";

export class UnsupportedRegex extends Error {}

type Node =
  | { readonly kind: "alt"; readonly options: readonly Node[] }
  | { readonly kind: "seq"; readonly items: readonly Node[] }
  | { readonly kind: "repeat"; readonly item: Node; readonly min: number; readonly max: number }
  | { readonly kind: "class"; readonly pool: readonly string[] }
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "empty" };

const digits = [..."0123456789"];
const word = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"];
const space = [..." \t\n\r\f\v"];
/** What `.` and negated classes draw from: printable ASCII, a few others, no newline. */
const anyChar = [
  ..." !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~üß日",
];

/** A plentiful count for an unbounded quantifier: keeps drawn strings short. */
const unboundedExtra = 4;
/** The most a counted quantifier may ask for; a guard wanting more is left to sampling. */
const maxRepeat = 1000;
/** The longest string one draw may build before it is given up. */
const maxLength = 10_000;
/** The most nodes one draw may visit: nested repetitions of empty matches multiply work without length. */
const maxSteps = 100_000;

/** A class node over the characters it can draw; negation is resolved here, once. */
function classNode(chars: readonly string[], negated: boolean): Node {
  const pool = negated ? anyChar.filter((c) => !chars.includes(c)) : chars;
  if (pool.length === 0) throw new UnsupportedRegex("an empty class matches nothing");
  return { kind: "class", pool };
}

class Parser {
  private at = 0;
  private readonly src: string;
  private readonly dotAll: boolean;
  private readonly unicode: boolean;
  constructor(src: string, flags: string) {
    this.src = src;
    this.dotAll = flags.includes("s");
    this.unicode = flags.includes("u");
  }

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.src.length) throw new UnsupportedRegex(`unexpected ${this.src[this.at]}`);
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.at];
  }

  private take(): string {
    const c = this.src[this.at++];
    if (c === undefined) throw new UnsupportedRegex("pattern ends early");
    return c;
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === "|") {
      this.at++;
      options.push(this.sequence());
    }
    return options.length === 1 ? (options[0] as Node) : { kind: "alt", options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.at < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return items.length === 1 ? (items[0] as Node) : { kind: "seq", items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, unboundedExtra];
    else if (c === "+") [min, max] = [1, 1 + unboundedExtra];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.at));
      if (!m) return atom; // a literal brace
      min = Number(m[1]);
      max =
        m[2] === undefined
          ? min
          : m[3] === "" || m[3] === undefined
            ? min + unboundedExtra
            : Number(m[3]);
      if (max < min) throw new UnsupportedRegex(`quantifier {${min},${max}} is empty`);
      if (max > maxRepeat)
        throw new UnsupportedRegex(`quantifier {${min},${max}} repeats too much to draw`);
      this.at += m[0].length - 1;
    } else return atom;
    this.at++;
    if (this.peek() === "?") this.at++; // lazy: same language
    return { kind: "repeat", item: atom, min, max };
  }

  private atom(): Node {
    const c = this.take();
    switch (c) {
      case "(": {
        if (this.src.startsWith("?:", this.at)) this.at += 2;
        else if (
          this.src.startsWith("?<", this.at) &&
          !"=!".includes(this.src[this.at + 2] ?? "")
        ) {
          const close = this.src.indexOf(">", this.at);
          if (close < 0) throw new UnsupportedRegex("unterminated group name");
          this.at = close + 1;
        } else if (this.peek() === "?") throw new UnsupportedRegex("lookaround or modifier group");
        const inner = this.alternation();
        if (this.take() !== ")") throw new UnsupportedRegex("unbalanced parenthesis");
        return inner;
      }
      case "[":
        return this.charClass();
      case ".":
        return classNode(this.dotAll ? [...anyChar, "\n"] : anyChar, false);
      case "^":
      case "$":
        return { kind: "empty" };
      case "\\":
        return this.escape(false);
      case ")":
      case "|":
      case "*":
      case "+":
      case "?":
        throw new UnsupportedRegex(`unexpected ${c}`);
      default:
        return { kind: "literal", text: c };
    }
  }

  /** An escape after `\`; inside a class, `\b` is a backspace. */
  private escape(inClass: boolean): Node {
    const e = this.take();
    switch (e) {
      case "d":
        return classNode(digits, false);
      case "D":
        return classNode(digits, true);
      case "w":
        return classNode(word, false);
      case "W":
        return classNode(word, true);
      case "s":
        return classNode(space, false);
      case "S":
        return classNode(space, true);
      case "n":
        return { kind: "literal", text: "\n" };
      case "t":
        return { kind: "literal", text: "\t" };
      case "r":
        return { kind: "literal", text: "\r" };
      case "f":
        return { kind: "literal", text: "\f" };
      case "v":
        return { kind: "literal", text: "\v" };
      case "0":
        return { kind: "literal", text: "\0" };
      case "b":
        if (inClass) return { kind: "literal", text: "\b" };
        return { kind: "empty" };
      case "B":
        return { kind: "empty" };
      case "x": {
        const hex = this.src.slice(this.at, this.at + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new UnsupportedRegex("bad \\x escape");
        this.at += 2;
        return { kind: "literal", text: String.fromCharCode(Number.parseInt(hex, 16)) };
      }
      case "u": {
        if (this.peek() === "{") {
          // Without the u flag, \u{43} is the letter u 43 times.
          if (!this.unicode) throw new UnsupportedRegex("\\u{} without the u flag");
          const close = this.src.indexOf("}", this.at);
          const hex = this.src.slice(this.at + 1, close);
          if (close < 0 || !/^[0-9a-fA-F]{1,6}$/.test(hex))
            throw new UnsupportedRegex("bad \\u escape");
          this.at = close + 1;
          return { kind: "literal", text: String.fromCodePoint(Number.parseInt(hex, 16)) };
        }
        const hex = this.src.slice(this.at, this.at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new UnsupportedRegex("bad \\u escape");
        this.at += 4;
        return { kind: "literal", text: String.fromCharCode(Number.parseInt(hex, 16)) };
      }
      case "p":
      case "P":
      case "k":
      case "c":
        throw new UnsupportedRegex(`\\${e} escapes`);
      default:
        if (/[1-9]/.test(e)) throw new UnsupportedRegex("backreferences");
        return { kind: "literal", text: e };
    }
  }

  /** `[...]` after its opening bracket. `[]` is empty and `[]a]` is an empty class then `a]`, as in JavaScript. */
  private charClass(): Node {
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.at++;
    }
    const chars = new Set<string>();
    while (this.peek() !== "]") {
      const c = this.take();
      let member: string;
      if (c === "\\") {
        const node = this.escape(true);
        if (node.kind === "class") {
          // \d inside a class adds its members; \D its complement, already resolved over anyChar.
          for (const x of node.pool) chars.add(x);
          continue;
        }
        if (node.kind !== "literal") throw new UnsupportedRegex("escape in class");
        member = node.text;
      } else member = c;
      if (
        this.peek() === "-" &&
        this.src[this.at + 1] !== "]" &&
        this.src[this.at + 1] !== undefined
      ) {
        this.at++;
        const to =
          this.take() === "\\"
            ? this.escape(true)
            : { kind: "literal" as const, text: this.src[this.at - 1] as string };
        if (to.kind !== "literal") throw new UnsupportedRegex("range to a class");
        const lo = member.codePointAt(0) as number;
        const hi = to.text.codePointAt(0) as number;
        if (hi < lo) throw new UnsupportedRegex("range out of order");
        if (hi - lo > 0x2000) throw new UnsupportedRegex("range too wide to enumerate");
        for (let p = lo; p <= hi; p++) chars.add(String.fromCodePoint(p));
        continue;
      }
      chars.add(member);
    }
    this.at++;
    return classNode([...chars], negated);
  }
}

/** The pattern as a tree, or `UnsupportedRegex`. */
export function parseRegex(pattern: string, flags: string): Node {
  if (flags.includes("v")) throw new UnsupportedRegex("the v flag");
  return new Parser(pattern, flags).parse();
}

/** One string from the tree, with the state that follows. */
export function drawRegex(node: Node, state: PrngState): readonly [string, PrngState] {
  let s = state;
  let steps = 0;
  const go = (n: Node): string => {
    if (++steps > maxSteps) throw new UnsupportedRegex("a draw visited more than 100000 nodes");
    switch (n.kind) {
      case "empty":
        return "";
      case "literal":
        return n.text;
      case "alt": {
        const [i, next] = nextInt(s, n.options.length);
        s = next;
        return go(n.options[i] as Node);
      }
      case "seq":
        return n.items.map(go).join("");
      case "repeat": {
        const [extra, next] = nextInt(s, n.max - n.min + 1);
        s = next;
        let out = "";
        for (let i = 0; i < n.min + extra; i++) {
          out += go(n.item);
          if (out.length > maxLength)
            throw new UnsupportedRegex("a draw grew past 10000 characters");
        }
        return out;
      }
      case "class": {
        const [i, next] = nextInt(s, n.pool.length);
        s = next;
        return n.pool[i] as string;
      }
    }
  };
  return [go(node), s];
}
