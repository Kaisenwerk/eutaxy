/**
 * Invariants are plain data describing a property of the effect log; checkers
 * are pure functions from (log, invariant) to a violation or null. The
 * library starts with what the first planted bug needs and grows from there.
 */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { EffectLog } from "./effect-log.ts";
import { checkRefines, type Refines } from "./refines.ts";
import { type EffectSelector, getPath, keyOf, selectEffects } from "./selectors.ts";
import {
  checkEveryRow,
  checkImplies,
  checkUnique,
  type EveryRow,
  type Implies,
  type Unique,
} from "./state.ts";

/** No two selected effects share the same key. Catches duplicate writes. */
export interface AtMostOncePerKey {
  readonly kind: "atMostOncePerKey";
  readonly name: string;
  readonly effect: EffectSelector;
  /** Dot path into the payload that identifies the key. */
  readonly key: string;
}

/** Every expected key appears in at least one selected effect. Catches lost work. */
export interface AtLeastOnce {
  readonly kind: "atLeastOnce";
  readonly name: string;
  readonly effect: EffectSelector;
  readonly key: string;
  readonly expected: readonly JsonValue[];
  /** Set when `expected` was derived from the drive's message bodies, so it can be re-derived when messages are removed. */
  readonly perMessage?: { readonly bodyKey: string };
}

/** Re-derive `expected` for per-message invariants from the bodies that remain. */
export function recomputePerMessageExpected(
  invariants: readonly Invariant[],
  bodies: readonly JsonValue[],
): readonly Invariant[] {
  return invariants.map((inv) => {
    if (inv.kind !== "atLeastOnce" || !inv.perMessage) return inv;
    const bodyKey = inv.perMessage.bodyKey;
    const expected: JsonValue[] = [];
    for (const b of bodies) {
      const v = getPath(b, bodyKey);
      if (v !== undefined) expected.push(v);
    }
    return { ...inv, expected };
  });
}

export type Invariant = AtMostOncePerKey | AtLeastOnce | EveryRow | Implies | Unique | Refines;

export interface Violation {
  readonly invariant: string;
  readonly message: string;
  /** The keys involved, in canonical JSON, so two violations can be compared across runs. */
  readonly keys: readonly string[];
  /** Sequence numbers of the effects that witness the violation. */
  readonly evidence: readonly number[];
}

/** True when two violations are of the same invariant for the same keys, whatever the traces. */
export function sameViolation(a: Violation, b: Violation): boolean {
  return (
    a.invariant === b.invariant &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}

export function checkInvariant(log: EffectLog, inv: Invariant): Violation | null {
  switch (inv.kind) {
    case "refines":
      return checkRefines(log, inv);
    case "everyRow":
      return checkEveryRow(log, inv);
    case "implies":
      return checkImplies(log, inv);
    case "unique":
      return checkUnique(log, inv);
    case "atMostOncePerKey": {
      const seen = new Map<string, number>();
      for (const e of selectEffects(log, inv.effect)) {
        const k = keyOf(e, inv.key);
        if (k === undefined) continue;
        const first = seen.get(k);
        if (first !== undefined) {
          return {
            invariant: inv.name,
            message: `${inv.effect.target} ${inv.effect.op ?? "*"} happened twice for key ${k} (seq ${first} and ${e.seq})`,
            keys: [k],
            evidence: [first, e.seq],
          };
        }
        seen.set(k, e.seq);
      }
      return null;
    }
    case "atLeastOnce": {
      const present = new Set<string>();
      const selected = selectEffects(log, inv.effect);
      for (const e of selected) {
        const k = keyOf(e, inv.key);
        if (k !== undefined) present.add(k);
      }
      const missing = inv.expected.map((v) => canonicalJson(v)).filter((k) => !present.has(k));
      if (missing.length === 0) return null;
      return {
        invariant: inv.name,
        message: `${inv.effect.target} ${inv.effect.op ?? "*"} never happened for key(s) ${missing.join(", ")}`,
        keys: missing,
        evidence: selected.map((e) => e.seq),
      };
    }
  }
}

export function checkInvariants(
  log: EffectLog,
  invariants: readonly Invariant[],
): readonly Violation[] {
  const out: Violation[] = [];
  for (const inv of invariants) {
    const v = checkInvariant(log, inv);
    if (v) out.push(v);
  }
  return out;
}
