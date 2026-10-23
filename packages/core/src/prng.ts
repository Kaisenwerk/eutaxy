/**
 * A pure, seedable pseudo-random generator (xoshiro128**).
 *
 * State is an immutable tuple of four 32-bit words. Every operation returns a
 * value and the next state; nothing is mutated, so a schedule can be replayed
 * from any state and two explorations can never interfere with each other.
 * Not cryptographic.
 */

export type PrngState = readonly [number, number, number, number];

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** splitmix32: expands a 32-bit seed into well-mixed words for seeding. */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a over UTF-16 code units, so string seeds are stable across runtimes. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive an initial state from a number (taken modulo 2^32) or a string. */
export function seedPrng(seed: number | string): PrngState {
  const word = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  const next = splitmix32(word);
  const s: [number, number, number, number] = [next(), next(), next(), next()];
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) {
    s[0] = 1; // xoshiro must never hold the all-zero state
  }
  return s;
}

/** Next 32-bit unsigned integer and the state that follows it. */
export function nextU32(state: PrngState): readonly [number, PrngState] {
  const [s0, s1, s2, s3] = state;
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  let n2 = (s2 ^ s0) >>> 0;
  let n3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2) >>> 0;
  const n0 = (s0 ^ n3) >>> 0;
  n2 = (n2 ^ t) >>> 0;
  n3 = rotl(n3, 11);
  return [result, [n0, n1, n2, n3]];
}

/** Next float in [0, 1) with 24 bits of precision. */
export function nextFloat(state: PrngState): readonly [number, PrngState] {
  const [u, next] = nextU32(state);
  return [(u >>> 8) * 2 ** -24, next];
}

/**
 * Next integer in [0, bound). Uses rejection sampling, so every value is
 * equally likely; a bound of 1 always yields 0 without consuming state.
 */
export function nextInt(state: PrngState, bound: number): readonly [number, PrngState] {
  if (!Number.isInteger(bound) || bound < 1 || bound > 0x1_0000_0000) {
    throw new RangeError(`nextInt bound must be an integer in [1, 2^32], got ${bound}`);
  }
  if (bound === 1) return [0, state];
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
  let s = state;
  for (;;) {
    const [u, next] = nextU32(s);
    s = next;
    if (u < limit) return [u % bound, s];
  }
}

/**
 * Split one generator into two independent streams: the first element is the
 * continuation of the parent, the second a freshly seeded child.
 */
export function fork(state: PrngState): readonly [PrngState, PrngState] {
  const [a, s1] = nextU32(state);
  const [b, s2] = nextU32(s1);
  const next = splitmix32((a ^ Math.imul(b, 0x9e3779b1)) >>> 0);
  const child: [number, number, number, number] = [next(), next(), next(), next()];
  if (child[0] === 0 && child[1] === 0 && child[2] === 0 && child[3] === 0) child[0] = 1;
  return [s2, child];
}
