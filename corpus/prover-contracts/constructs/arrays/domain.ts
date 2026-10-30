/**
 * Arrays, in the shape an invariant checker has: a list of effects
 * (records), counted by kind, and a list of keys searched for a repeat.
 * The rungs without an engine draw and shrink arrays; neither engine
 * translates them yet.
 */

export interface Effect {
  readonly key: string;
  readonly op: string;
}

export function countOp(effects: readonly Effect[], op: string): number {
  let n = 0;
  for (const e of effects) if (e.op === op) n++;
  return n;
}

export function firstRepeat(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}
