/**
 * Inputs for the `TESTED` rung: values drawn from a binder's type, steered
 * by what the precondition says about it, with core's seeded generator;
 * and the smaller values a shrinker tries in place of one that broke a
 * property. Everything here is pure: the same state draws the same value,
 * so a `TESTED` verdict and its counterexample come out the same on every
 * machine.
 */

import { nextFloat, nextInt, nextU32, type PrngState } from "@eutaxy/core";
import { type Binder, describeType, type Endpoint, type Hint, type SpecType } from "@eutaxy/spec";
import { drawRegex, parseRegex, UnsupportedRegex } from "./regex-gen.ts";
import { same } from "./render.ts";

/** A value and the state that follows drawing it. */
export type Draw<T> = readonly [T, PrngState];

/** Thrown when no value could be drawn: `unsupported` for a type the rung cannot draw, `gave_up` for a range nothing lies in. */
export class CannotGenerate extends Error {
  readonly why: "unsupported" | "gave_up";
  constructor(why: "unsupported" | "gave_up", message: string) {
    super(message);
    this.why = why;
  }
}

/** Integers are drawn as doubles, so they stay exact. */
const safe = 2n ** 53n - 1n;

/** How far an unguarded side of a bigint range reaches. */
const bigintReach = 1n << 128n;

/** A finite endpoint's value as a double. */
export function endpointNumber(value: string): number {
  return Number(value.replace(/_/g, "").replace(/n$/, ""));
}

/**
 * The integers a bound admits, as the bound itself: `n < 5` admits up to 4,
 * `n <= 5` up to 5, `n < 4.5` up to 4; `0 < n` from 1, `-0.5 <= n` from 0.
 */
export function integerBound(e: Endpoint, side: "lower" | "upper"): bigint | undefined {
  const text = e.value.replace(/_/g, "").replace(/n$/, "");
  if (/[.eE]/.test(text)) {
    const n = Number(text);
    // A literal past every double (`1e400`) bounds nothing an integer can reach.
    if (!Number.isFinite(n)) return undefined;
    if (!Number.isInteger(n)) return BigInt(side === "lower" ? Math.ceil(n) : Math.floor(n));
    return BigInt(n) + (e.inclusive ? 0n : side === "lower" ? 1n : -1n);
  }
  return BigInt(text) + (e.inclusive ? 0n : side === "lower" ? 1n : -1n);
}

/** A finite integral endpoint's value, exact: underscores and the `n` suffix dropped. */
export function endpointBigInt(value: string): bigint {
  return BigInt(value.replace(/_/g, "").replace(/n$/, ""));
}

/**
 * The closed integer interval a hint admits: within what a double holds
 * exactly for `number`; for `bigint`, the hint's ends, an unhinted side
 * reaching 2^128 past the other. Undefined when no integer lies in it.
 */
function integerRange(
  kind: "number" | "bigint",
  hint: Hint | undefined,
): { readonly lo: bigint; readonly hi: bigint } | undefined {
  const guardLo = hint?.lower === undefined ? undefined : integerBound(hint.lower, "lower");
  const guardHi = hint?.upper === undefined ? undefined : integerBound(hint.upper, "upper");
  let lo: bigint;
  let hi: bigint;
  if (kind === "bigint") {
    lo =
      guardLo ?? (guardHi === undefined ? -bigintReach : min(-bigintReach, guardHi - bigintReach));
    hi = guardHi ?? (guardLo === undefined ? bigintReach : max(bigintReach, guardLo + bigintReach));
  } else {
    lo = max(-safe, guardLo ?? -safe);
    hi = min(safe, guardHi ?? safe);
  }
  return lo <= hi ? { lo, hi } : undefined;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Uniform in [lo, hi], however wide: enough 32-bit words, masked, rejected when past the span. */
export function uniformBigInt(lo: bigint, hi: bigint, state: PrngState): Draw<bigint> {
  const span = hi - lo + 1n;
  if (span <= 0n) throw new RangeError(`empty integer interval [${lo}, ${hi}]`);
  if (span === 1n) return [lo, state];
  let bits = 0;
  for (let x = span - 1n; x > 0n; x >>= 1n) bits++;
  const words = Math.ceil(bits / 32);
  const mask = (1n << BigInt(bits)) - 1n;
  let s = state;
  for (;;) {
    let r = 0n;
    for (let i = 0; i < words; i++) {
      const [u, next] = nextU32(s);
      s = next;
      r = (r << 32n) | BigInt(u);
    }
    r &= mask;
    if (r < span) return [lo + r, s];
  }
}

/** One of a list, uniformly. */
function pick<T>(items: readonly T[], state: PrngState): Draw<T> {
  const [i, s] = nextInt(state, items.length);
  return [items[i] as T, s];
}

/**
 * An integer from the range, biased: most draws are small, since
 * properties fail at boundaries and small cases far more often than deep in
 * the range, some are medium or large, and a few are the range's edges.
 */
function drawInteger(
  name: string,
  kind: "number" | "bigint",
  hint: Hint | undefined,
  state: PrngState,
): Draw<bigint> {
  const range = integerRange(kind, hint);
  if (!range)
    throw new CannotGenerate(
      "gave_up",
      kind === "bigint"
        ? `no integer lies inside the precondition's bounds on ${name}`
        : `no integer lies inside the precondition's bounds on ${name} within ±2^53, which is as far as draws of number go`,
    );
  const { lo, hi } = range;
  const [cls, s] = nextInt(state, 100);
  const within = (a: bigint, z: bigint): [bigint, bigint] | undefined => {
    const l = max(lo, a);
    const h = min(hi, z);
    return l <= h ? [l, h] : undefined;
  };
  if (cls < 5) {
    const edges = [lo, hi, 0n, 1n, -1n, lo + 1n, hi - 1n].filter((v) => v >= lo && v <= hi);
    return pick(edges, s);
  }
  const bound =
    cls < 55
      ? within(-16n, 16n)
      : cls < 80
        ? within(-(1n << 16n), 1n << 16n)
        : cls < 95
          ? within(-(1n << 31n), 1n << 31n)
          : undefined;
  const [l, h] = bound ?? [lo, hi];
  return uniformBigInt(l, h, s);
}

/** The double interval a hint admits. */
function numberRange(hint: Hint | undefined): {
  readonly lo: number;
  readonly hi: number;
  readonly guarded: boolean;
} {
  const lo =
    hint?.lower === undefined ? Number.NEGATIVE_INFINITY : endpointNumber(hint.lower.value);
  const hi =
    hint?.upper === undefined ? Number.POSITIVE_INFINITY : endpointNumber(hint.upper.value);
  return { lo, hi, guarded: hint?.lower !== undefined || hint?.upper !== undefined };
}

/** Whether a double satisfies the hint's bounds (NaN satisfies none). */
function withinNumberHint(hint: Hint | undefined, v: number): boolean {
  if (!hint) return true;
  if (hint.integer && !Number.isInteger(v)) return false;
  if (hint.lower) {
    const lo = endpointNumber(hint.lower.value);
    if (!(hint.lower.inclusive ? v >= lo : v > lo)) return false;
  }
  if (hint.upper) {
    const hi = endpointNumber(hint.upper.value);
    if (!(hint.upper.inclusive ? v <= hi : v < hi)) return false;
  }
  return true;
}

function drawNumber(hint: Hint | undefined, state: PrngState): Draw<number> {
  const { lo, hi, guarded } = numberRange(hint);
  const [cls, s0] = nextInt(state, 100);
  if (cls < 8) {
    const edges = [
      0,
      -0,
      1,
      -1,
      0.5,
      Number.MIN_VALUE,
      Number.EPSILON,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      ...(guarded ? [lo, hi] : [Number.NaN]),
    ].filter((v) => withinNumberHint(hint, v));
    if (edges.length > 0) return pick(edges, s0);
  }
  if (cls < 35) {
    const [k, s1] = nextInt(s0, 33);
    return [k - 16, s1];
  }
  if (cls < 60) {
    const [d, s1] = pick([2, 4, 8, 10, 100], s0);
    const [k, s2] = nextInt(s1, 65);
    return [(k - 32) / d, s2];
  }
  if (cls < 80 && Number.isFinite(lo) && Number.isFinite(hi)) {
    const [f, s1] = nextFloat(s0);
    return [lo + f * (hi - lo), s1];
  }
  // Any magnitude a double holds: a random mantissa at a random binary exponent, either sign.
  const [f, s1] = nextFloat(s0);
  const [e, s2] = nextInt(s1, 2100);
  const [neg, s3] = nextInt(s2, 2);
  return [(neg ? -1 : 1) * (1 + f) * 2 ** (e - 1074), s3];
}

const letters = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const plainAlphabet = [...`${letters}${letters.toUpperCase()}${digits} _-.,:/\n'"üß日😀`];
const stringEdges = ["", " ", "a", "0", "-1", "\n", "\u0000", "ü", "😀", "a".repeat(100)];

/**
 * The characters a regex names: literals, the ranges and escapes of its
 * classes. Strings drawn from them match the pattern far more often than
 * strings drawn from everything, which is what the rejection below needs.
 */
export function regexAlphabet(pattern: string): string[] {
  const chars = new Set<string>();
  const add = (s: string) => {
    for (const c of s) chars.add(c);
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      const e = pattern[++i];
      if (e === "d") add(digits);
      else if (e === "w") add(`${letters}${letters.toUpperCase()}${digits}_`);
      else if (e === "s") add(" ");
      else if (e === "n") add("\n");
      else if (e === "t") add("\t");
      else if (e !== undefined && !/[DWSbBuxpP]/.test(e)) add(e);
      continue;
    }
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      const from = c.codePointAt(0) as number;
      const to = (pattern[i + 2] as string).codePointAt(0) as number;
      if (from < to && to - from <= 0x1000)
        for (let p = from; p <= to; p++) chars.add(String.fromCodePoint(p));
      i += 2;
      continue;
    }
    if (!"^$()[]{}|*+?.-".includes(c)) chars.add(c);
  }
  return [...chars];
}

/** A string of `length` characters from `alphabet`. */
function drawChars(alphabet: readonly string[], length: number, state: PrngState): Draw<string> {
  let s = state;
  let out = "";
  for (let i = 0; i < length; i++) {
    const [c, next] = pick(alphabet, s);
    s = next;
    out += c;
  }
  return [out, s];
}

/** Whether a string passes the hint's regex (the real RegExp has the last word). */
function matchesRegex(hint: Hint | undefined, v: string): boolean {
  return hint?.regex === undefined || new RegExp(hint.regex.pattern, hint.regex.flags).test(v);
}

function drawString(hint: Hint | undefined, state: PrngState): Draw<string> {
  const g = hint?.regex;
  if (!g) {
    const [cls, s0] = nextInt(state, 100);
    if (cls < 15) return pick(stringEdges, s0);
    const [length, s1] = nextInt(s0, 25);
    return drawChars(plainAlphabet, length, s1);
  }
  let s = state;
  // Walk the pattern when it is in the understood subset; the real RegExp has the last word.
  let tree: ReturnType<typeof parseRegex> | undefined;
  try {
    tree = parseRegex(g.pattern, g.flags);
  } catch (err) {
    if (!(err instanceof UnsupportedRegex)) throw err;
  }
  for (let attempt = 0; tree && attempt < 16; attempt++) {
    try {
      const [candidate, s1] = drawRegex(tree, s);
      s = s1;
      if (matchesRegex(hint, candidate)) return [candidate, s];
    } catch (err) {
      if (!(err instanceof UnsupportedRegex)) throw err;
      break;
    }
  }
  // Otherwise sample strings over the pattern's own characters and keep what matches.
  const fromPattern = regexAlphabet(g.pattern);
  const alphabet = fromPattern.length > 0 ? fromPattern : plainAlphabet;
  for (let attempt = 0; attempt < 64; attempt++) {
    const [length, s1] = nextInt(s, 13);
    const [candidate, s2] = drawChars(alphabet, length, s1);
    s = s2;
    if (matchesRegex(hint, candidate)) return [candidate, s];
  }
  throw new CannotGenerate(
    "gave_up",
    `no string matching /${g.pattern}/${g.flags} was found in 64 draws over its characters`,
  );
}

/** A value of the type, within the hint (which applies to a top-level binder only). */
export function generateOf(
  name: string,
  type: SpecType,
  hint: Hint | undefined,
  state: PrngState,
): Draw<unknown> {
  switch (type.kind) {
    case "boolean": {
      const [bit, s] = nextInt(state, 2);
      return [bit === 1, s];
    }
    case "number": {
      if (hint?.integer) {
        const [v, s] = drawInteger(name, "number", hint, state);
        return [Number(v), s];
      }
      let s = state;
      for (let attempt = 0; attempt < 64; attempt++) {
        const [v, next] = drawNumber(hint, s);
        s = next;
        if (withinNumberHint(hint, v)) return [v, s];
      }
      throw new CannotGenerate(
        "gave_up",
        `no number inside the precondition's bounds on ${name} was found in 64 draws`,
      );
    }
    case "bigint":
      return drawInteger(name, "bigint", hint, state);
    case "string":
      return drawString(hint, state);
    case "literal":
      return [type.value, state];
    case "null":
      return [null, state];
    case "undefined":
      return [undefined, state];
    case "union": {
      const [member, s] = pick(type.members, state);
      return generateOf(name, member, undefined, s);
    }
    case "record": {
      let s = state;
      const out: Record<string, unknown> = {};
      for (const f of type.fields) {
        const [v, next] = generateOf(`${name}.${f.name}`, f.type, undefined, s);
        s = next;
        out[f.name] = v;
      }
      return [out, s];
    }
    case "unknown":
      throw new CannotGenerate(
        "unsupported",
        `${name} has a type the rung cannot draw from: ${describeType(type)}`,
      );
  }
}

/** A value of the binder's type, within its hint. */
export function generate(b: Binder, state: PrngState): Draw<unknown> {
  return generateOf(b.name, b.type, b.hint, state);
}

/** Whether a binder draws integers (or bigints), which later binders may relate to. */
function integral(b: Binder): boolean {
  return b.type.kind === "bigint" || (b.type.kind === "number" && b.hint?.integer === true);
}

/**
 * One assignment to every binder. Each is drawn from its own type and
 * hint; a later integer binder is sometimes made to relate to earlier
 * ones instead, equal to one or the sum or difference of two, since
 * preconditions relate binders (`refunded + amount === captured`) and
 * independent draws would meet such an equation once in thousands. A
 * related value outside the binder's hint is dropped for the draw.
 */
export function generateAssignment(binders: readonly Binder[], state: PrngState): Draw<unknown[]> {
  const values: unknown[] = [];
  let s = state;
  for (const b of binders) {
    const [drawn, next] = generate(b, s);
    s = next;
    let v = drawn;
    const earlier = values.filter(
      (x, i) => integral(binders[i] as Binder) && typeof x === typeof drawn,
    );
    if (integral(b) && earlier.length > 0) {
      const [cls, s1] = nextInt(s, 10);
      s = s1;
      if (cls < 3) {
        const [a, s2] = pick(earlier, s1);
        const [c, s3] = pick(earlier, s2);
        s = s3;
        let related: unknown = a;
        if (cls === 1)
          related =
            typeof a === "bigint" ? (a as bigint) + (c as bigint) : (a as number) + (c as number);
        if (cls === 2)
          related =
            typeof a === "bigint" ? (a as bigint) - (c as bigint) : (a as number) - (c as number);
        if (inDomain(b, related) && (typeof related !== "number" || Number.isSafeInteger(related)))
          v = related;
      }
    }
    values.push(v);
  }
  return [values, s];
}

/** Whether a value is of the type (hints aside). */
export function conforms(type: SpecType, v: unknown): boolean {
  switch (type.kind) {
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "bigint":
      return typeof v === "bigint";
    case "literal":
      // `===`: -0 is of the literal type 0, as TypeScript has it.
      return v === type.value;
    case "null":
      return v === null;
    case "undefined":
      return v === undefined;
    case "union":
      return type.members.some((m) => conforms(m, v));
    case "record":
      return (
        typeof v === "object" &&
        v !== null &&
        type.fields.every((f) => conforms(f.type, (v as Record<string, unknown>)[f.name]))
      );
    case "unknown":
      return true;
  }
}

/** Whether a top-level value is of the binder's type and within its hint. */
export function inDomain(b: Binder, v: unknown): boolean {
  if (!conforms(b.type, v)) return false;
  const h = b.hint;
  if (!h) return true;
  if (typeof v === "number") return withinNumberHint(h, v);
  if (typeof v === "bigint") {
    const lo = h.lower && integerBound(h.lower, "lower");
    const hi = h.upper && integerBound(h.upper, "upper");
    if (lo !== undefined && v < lo) return false;
    if (hi !== undefined && v > hi) return false;
    return true;
  }
  if (typeof v === "string") return matchesRegex(h, v);
  return true;
}

/** The integer nearest to zero in [lo, hi]. */
function nearestZero(lo: bigint, hi: bigint): bigint {
  return lo > 0n ? lo : hi < 0n ? hi : 0n;
}

/** Steps from `v` toward `target`: the target itself, then the halfway points back toward `v`. */
function towards(v: bigint, target: bigint): bigint[] {
  const out: bigint[] = [];
  if (v === target) return out;
  out.push(target);
  let d = (v - target) / 2n;
  while (d !== 0n) {
    out.push(v - d);
    d /= 2n;
  }
  return out;
}

/**
 * Smaller values to try in place of `v`, simplest first, all of the type
 * and within the hint, none equal to `v`. Numbers move toward zero (or the
 * bound nearest it), strings get shorter and plainer, `true` becomes
 * `false`, a union moves to its simplest member, a record shrinks one
 * field at a time.
 */
export function shrinkCandidates(b: Binder, v: unknown): unknown[] {
  return candidatesOf(b.type, b.hint, v).filter((c) => !Object.is(c, v) && inDomain(b, c));
}

function candidatesOf(type: SpecType, hint: Hint | undefined, v: unknown): unknown[] {
  const dedupe = (xs: unknown[]) => {
    const out: unknown[] = [];
    for (const x of xs) if (!out.some((y) => same(x, y))) out.push(x);
    return out;
  };
  switch (type.kind) {
    case "boolean":
      return [false];
    case "number": {
      if (typeof v !== "number") return [];
      if (hint?.integer || Number.isInteger(v)) {
        const range = integerRange("number", hint);
        if (!Number.isInteger(v) || !range) return [];
        return dedupe(towards(BigInt(v), nearestZero(range.lo, range.hi)).map(Number));
      }
      const { lo, hi } = numberRange(hint);
      const target = lo > 0 ? lo : Math.min(hi, 0);
      if (!Number.isFinite(v)) return [target, 1, -1, Number.MAX_VALUE, -Number.MAX_VALUE];
      const out = [target, Math.trunc(v)];
      let d = (v - target) / 2;
      for (let i = 0; i < 24 && d !== 0; i++) {
        out.push(v - d);
        d /= 2;
      }
      return dedupe(out);
    }
    case "bigint": {
      const range = integerRange("bigint", hint);
      if (typeof v !== "bigint" || !range) return [];
      return towards(v, nearestZero(range.lo, range.hi));
    }
    case "string": {
      if (typeof v !== "string") return [];
      const chars = [...v];
      const out: string[] = ["", chars.slice(0, Math.floor(chars.length / 2)).join("")];
      out.push(chars.slice(Math.ceil(chars.length / 2)).join(""));
      for (const at of [0, chars.length - 1, Math.floor(chars.length / 2)])
        out.push([...chars.slice(0, at), ...chars.slice(at + 1)].join(""));
      const first = chars.findIndex((c) => c !== "a");
      if (first >= 0) out.push([...chars.slice(0, first), "a", ...chars.slice(first + 1)].join(""));
      return dedupe(out);
    }
    case "literal":
    case "null":
    case "undefined":
    case "unknown":
      return [];
    case "union": {
      // The simplest value of each member first (null, false, 0, "", the first literal), then within v's own member.
      const simplest = type.members.flatMap((m): unknown[] => {
        switch (m.kind) {
          case "null":
            return [null];
          case "undefined":
            return [undefined];
          case "boolean":
            return [false];
          case "number":
            return [0];
          case "bigint":
            return [0n];
          case "string":
            return [""];
          case "literal":
            return [m.value];
          default:
            return [];
        }
      });
      const own = type.members.find((m) => conforms(m, v));
      return dedupe([...simplest, ...(own ? candidatesOf(own, undefined, v) : [])]);
    }
    case "record": {
      if (typeof v !== "object" || v === null) return [];
      const o = v as Record<string, unknown>;
      const out: unknown[] = [];
      for (const f of type.fields)
        for (const c of candidatesOf(f.type, undefined, o[f.name]))
          if (!same(c, o[f.name])) out.push({ ...o, [f.name]: c });
      return out;
    }
  }
}
