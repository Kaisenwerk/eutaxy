/**
 * Inputs for the `TESTED` rung: values drawn from a binder's domain and
 * guard with core's seeded generator, and the smaller values a shrinker
 * tries in place of one that broke a property. Everything here is pure:
 * the same state draws the same value, so a `TESTED` verdict and its
 * counterexample come out the same on every machine.
 */

import { nextFloat, nextInt, nextU32, type PrngState } from "@eutaxy/core";
import { type Binder, endpointNumber } from "@eutaxy/spec";
import { endpointBigInt, inDomain } from "./checked.ts";
import { drawRegex, parseRegex, UnsupportedRegex } from "./regex-gen.ts";

/** A value and the state that follows drawing it. */
export type Draw<T> = readonly [T, PrngState];

/** Thrown when no value of a binder's domain could be drawn within the guard. */
export class CannotGenerate extends Error {}

/** Integers are drawn as doubles, so they stay exact. */
const safe = 2n ** 53n - 1n;

/** How far an unguarded side of a bigint range reaches. */
const bigintReach = 1n << 128n;

/**
 * The closed integer interval a binder admits: within what a double holds
 * exactly for `int` and `nat`; for `bigint`, the guard's ends, an
 * unguarded side reaching 2^128 past the other. Undefined when no integer
 * lies in it, which the parser does not rule out (`int ∈ (0, 1)`).
 */
function integerRange(b: Binder): { readonly lo: bigint; readonly hi: bigint } | undefined {
  const g = b.guard?.kind === "interval" ? b.guard : undefined;
  const guardLo =
    g && !g.lower.value.endsWith("∞")
      ? endpointBigInt(g.lower.value) + (g.lower.inclusive ? 0n : 1n)
      : undefined;
  const guardHi =
    g && !g.upper.value.endsWith("∞")
      ? endpointBigInt(g.upper.value) - (g.upper.inclusive ? 0n : 1n)
      : undefined;
  let lo: bigint;
  let hi: bigint;
  if (b.domain === "bigint") {
    lo =
      guardLo ?? (guardHi === undefined ? -bigintReach : min(-bigintReach, guardHi - bigintReach));
    hi = guardHi ?? (guardLo === undefined ? bigintReach : max(bigintReach, guardLo + bigintReach));
  } else {
    lo = max(b.domain === "nat" ? 0n : -safe, guardLo ?? -safe);
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
 * An integer from the binder's range, biased: most draws are small, since
 * properties fail at boundaries and small cases far more often than deep in
 * the range, some are medium or large, and a few are the range's edges.
 */
function drawInteger(b: Binder, state: PrngState): Draw<bigint> {
  const range = integerRange(b);
  if (!range)
    throw new CannotGenerate(
      b.domain === "bigint"
        ? `no integer lies inside the guard of ${b.name}`
        : `no integer lies inside the guard of ${b.name} within ±2^53, which is as far as draws of ${b.domain} go`,
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

/** The double interval a `number` binder admits. */
function numberRange(b: Binder): {
  readonly lo: number;
  readonly hi: number;
  readonly guarded: boolean;
} {
  const g = b.guard;
  if (g?.kind !== "interval")
    return { lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY, guarded: false };
  return { lo: endpointNumber(g.lower.value), hi: endpointNumber(g.upper.value), guarded: true };
}

function drawNumber(b: Binder, state: PrngState): Draw<number> {
  const { lo, hi, guarded } = numberRange(b);
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
    ].filter((v) => inDomain(b, v));
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

function drawString(b: Binder, state: PrngState): Draw<string> {
  const g = b.guard;
  if (g?.kind !== "regex") {
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
      if (inDomain(b, candidate)) return [candidate, s];
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
    if (inDomain(b, candidate)) return [candidate, s];
  }
  throw new CannotGenerate(
    `no string matching /${g.pattern}/${g.flags} was found in 64 draws over its characters`,
  );
}

/** A value of the binder's domain within its guard. */
export function generate(b: Binder, state: PrngState): Draw<unknown> {
  switch (b.domain) {
    case "boolean": {
      const [bit, s] = nextInt(state, 2);
      return [bit === 1, s];
    }
    case "int":
    case "nat": {
      const [v, s] = drawInteger(b, state);
      return [Number(v), s];
    }
    case "bigint":
      return drawInteger(b, state);
    case "number": {
      let s = state;
      for (let attempt = 0; attempt < 64; attempt++) {
        const [v, next] = drawNumber(b, s);
        s = next;
        if (inDomain(b, v)) return [v, s];
      }
      throw new CannotGenerate(`no number inside the guard of ${b.name} was found in 64 draws`);
    }
    case "string":
      return drawString(b, state);
  }
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
 * Smaller values to try in place of `v`, simplest first, all within the
 * binder's domain and guard and none equal to `v`. Numbers move toward
 * zero (or the guard's end nearest it), strings get shorter and plainer,
 * `true` becomes `false`.
 */
export function shrinkCandidates(b: Binder, v: unknown): unknown[] {
  const keep = (xs: unknown[]) => {
    const seen = new Set<unknown>();
    return xs.filter((x) => {
      if (Object.is(x, v) || seen.has(x) || !inDomain(b, x)) return false;
      seen.add(x);
      return true;
    });
  };
  switch (b.domain) {
    case "boolean":
      return keep([false]);
    case "int":
    case "nat": {
      const range = integerRange(b);
      if (typeof v !== "number" || !Number.isInteger(v) || !range) return [];
      return keep(towards(BigInt(v), nearestZero(range.lo, range.hi)).map(Number));
    }
    case "bigint": {
      const range = integerRange(b);
      if (typeof v !== "bigint" || !range) return [];
      return keep(towards(v, nearestZero(range.lo, range.hi)));
    }
    case "number": {
      if (typeof v !== "number") return [];
      const { lo, hi } = numberRange(b);
      const target = lo > 0 ? lo : Math.min(hi, 0);
      if (!Number.isFinite(v)) return keep([target, 1, -1, Number.MAX_VALUE, -Number.MAX_VALUE]);
      const out = [target, Math.trunc(v)];
      let d = (v - target) / 2;
      for (let i = 0; i < 24 && d !== 0; i++) {
        out.push(v - d);
        d /= 2;
      }
      return keep(out);
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
      return keep(out);
    }
  }
}
