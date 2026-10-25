/** `refines`: the shell carries out the decisions its pure core made, and not on a stale read. */

import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import type { EffectLog, EffectRecord } from "./effect-log.ts";
import type { Violation } from "./invariants.ts";
import {
  type EffectSelector,
  getPath,
  jsonEqual,
  keyOf,
  matches,
  selectEffects,
} from "./selectors.ts";

/**
 * The shell follows the core. Calls to a pure core function are recorded as
 * decisions (`Core:<function>` results, payload `{ args, result }`). Every
 * selected effect must come after a decision of `decision` in its own
 * invocation; the latest such decision is the one it carries out. With
 * `follows`, the effect's payload agrees with that decision at each pair of
 * paths. With `state`, the decision rests on the last `read` its invocation
 * made before it (none is a violation), and no other invocation's `write`
 * (to the same `key`, when given) commits between that read and the effect:
 * otherwise the effect carried out a decision made on a stale read.
 */
export interface Refines {
  readonly kind: "refines";
  readonly name: string;
  /** The core function, as recorded. */
  readonly decision: string;
  readonly effect: EffectSelector;
  readonly follows?: readonly { readonly effect: string; readonly decision: string }[];
  readonly state?: {
    readonly read: EffectSelector;
    readonly write: EffectSelector;
    /** Dot path into the read's and the writes' payloads naming the state they touch. */
    readonly key?: string;
  };
}

/** The log target decisions of a core function are recorded under. */
export function decisionTarget(fn: string): string {
  return `Core:${fn}`;
}

export function checkRefines(log: EffectLog, inv: Refines): Violation | null {
  const target = decisionTarget(inv.decision);
  const before = (seq: number, invocation: string, pick: (e: EffectRecord) => boolean) => {
    let found: EffectRecord | undefined;
    for (const e of log.entries) {
      if (e.seq >= seq) break;
      if (e.invocation === invocation && pick(e)) found = e;
    }
    return found;
  };
  for (const effect of selectEffects(log, inv.effect)) {
    const what = `${effect.target} ${effect.op} (seq ${effect.seq}) in ${effect.invocation}`;
    // A call that threw decided nothing.
    const decision = before(
      effect.seq,
      effect.invocation,
      (e) =>
        e.target === target && e.kind === "result" && getPath(e.payload, "error") === undefined,
    );
    if (!decision) {
      return {
        invariant: inv.name,
        message: `${what} carries out no decision: ${inv.decision} was not called before it in that invocation`,
        keys: ["no_decision"],
        evidence: [effect.seq],
      };
    }
    for (const pair of inv.follows ?? []) {
      const got = getPath(effect.payload, pair.effect);
      const want = getPath(decision.payload, pair.decision);
      if (want === undefined ? got !== undefined : !jsonEqual(got, want)) {
        const show = (v: JsonValue | undefined) => (v === undefined ? "nothing" : canonicalJson(v));
        return {
          invariant: inv.name,
          message: `${what} does not follow the decision at seq ${decision.seq}: ${pair.effect} is ${show(got)} but the decision's ${pair.decision} is ${show(want)}`,
          keys: ["not_followed", pair.effect],
          evidence: [decision.seq, effect.seq],
        };
      }
    }
    const state = inv.state;
    if (!state) continue;
    const read = before(decision.seq, effect.invocation, (e) => matches(e, state.read));
    if (!read) {
      return {
        invariant: inv.name,
        message: `${what} carries out the decision at seq ${decision.seq}, which rests on no read of the state: ${state.read.target} ${state.read.op ?? "*"} was not read before it in that invocation`,
        keys: ["no_read"],
        evidence: [decision.seq, effect.seq],
      };
    }
    const key = state.key === undefined ? undefined : keyOf(read, state.key);
    const write = log.entries.find(
      (e) =>
        e.seq > read.seq &&
        e.seq < effect.seq &&
        e.invocation !== effect.invocation &&
        matches(e, state.write) &&
        (state.key === undefined || keyOf(e, state.key) === key),
    );
    if (write) {
      return {
        invariant: inv.name,
        message: `${what} carries out a decision made on a stale read: the decision at seq ${decision.seq} rests on the read at seq ${read.seq}${key === undefined ? "" : ` of ${key}`}, and ${write.invocation} changed it at seq ${write.seq} before the effect committed`,
        keys: ["stale_read", ...(key === undefined ? [] : [key])],
        evidence: [read.seq, decision.seq, write.seq, effect.seq],
      };
    }
  }
  return null;
}
