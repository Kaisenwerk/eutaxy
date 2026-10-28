/**
 * The invariant checkers as functions of plain data, for Eutaxy's own spec
 * file beside this one (`self-check.props.ts`): each builds an effect log
 * from drawn effects, runs the real checker on it, and returns what the
 * checker found. The spec file states, for every one, that it agrees with
 * a naive reference implementation. Not exported from the package and
 * never bundled: `eutaxy report packages/core/src` reads it.
 *
 * The domains are small on purpose (two targets, two ops, a few keys), so
 * drawn effects collide on target, op and key as real logs do.
 */

import type { JsonValue } from "./canonical-json.ts";
import { appendEffect, type EffectLog, emptyLog } from "./effect-log.ts";
import { checkInvariant } from "./invariants.ts";

/** One effect as drawn: what a delivery invariant reads of it. */
export interface DrawnEffect {
  readonly kind: "call" | "result" | "fault";
  readonly target: "A" | "B";
  readonly op: "run" | "send";
  /** The payload's `key`; null leaves it out of the payload. */
  readonly key: "1" | 1 | "b" | null;
  /** The payload's `status`, which a selector may require. */
  readonly status: "ok" | "err";
}

/** The parts of an effect selector the self-check varies; null leaves one out. */
export interface DrawnSelector {
  readonly target: "A" | "B";
  readonly op: "run" | "send" | null;
  readonly kind: "call" | "result" | "fault" | null;
  readonly status: "ok" | "err" | null;
}

/** Which of an anchor effect's fields a selector requires besides its target. */
export interface Mask {
  readonly op: boolean;
  readonly kind: boolean;
  readonly status: boolean;
}

/**
 * The selector built from effect `at` (cycling; target A when there are
 * none): its target, and its op, kind and status where the mask says. A
 * selector drawn on its own would rarely select two effects with one key;
 * one anchored on a drawn effect selects at least that one.
 */
export function anchored(effects: readonly DrawnEffect[], at: number, mask: Mask): DrawnSelector {
  const e = effects.length === 0 ? undefined : effects[at % effects.length];
  return {
    target: e?.target ?? "A",
    op: e && mask.op ? e.op : null,
    kind: e && mask.kind ? e.kind : null,
    status: e && mask.status ? e.status : null,
  };
}

/** A duplicate the checker reports: the key in canonical JSON and the two sequence numbers. */
export interface Duplicate {
  readonly key: string;
  readonly first: number;
  readonly second: number;
}

/** The effects as a log, one invocation, in order. */
export function logOf(effects: readonly DrawnEffect[]): EffectLog {
  let log = emptyLog;
  for (const e of effects) {
    const payload: { [k: string]: JsonValue } = { status: e.status };
    if (e.key !== null) payload["key"] = e.key;
    log = appendEffect(log, {
      kind: e.kind,
      invocation: "i",
      target: e.target,
      op: e.op,
      payload,
    });
  }
  return log;
}

function selector(s: DrawnSelector) {
  return {
    target: s.target,
    ...(s.op === null ? {} : { op: s.op }),
    ...(s.kind === null ? {} : { kind: s.kind }),
    ...(s.status === null ? {} : { where: { status: s.status } }),
  };
}

/** `atMostOncePerKey` on the drawn effects, selected as `anchored` says: the duplicate it reports, or null. */
export function atMostOnceDuplicate(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
): Duplicate | null {
  const v = checkInvariant(logOf(effects), {
    kind: "atMostOncePerKey",
    name: "once",
    effect: selector(anchored(effects, at, mask)),
    key: "key",
  });
  if (v === null) return null;
  return {
    key: v.keys[0] as string,
    first: v.evidence[0] as number,
    second: v.evidence[1] as number,
  };
}

/** `atLeastOnce` on the drawn effects, selected as `anchored` says: the expected keys it reports missing (canonical JSON); empty when it holds. */
export function atLeastOnceMissing(
  effects: readonly DrawnEffect[],
  at: number,
  mask: Mask,
  expected: readonly ("1" | 1 | "b")[],
): readonly string[] {
  const v = checkInvariant(logOf(effects), {
    kind: "atLeastOnce",
    name: "atLeast",
    effect: selector(anchored(effects, at, mask)),
    key: "key",
    expected,
  });
  return v === null ? [] : v.keys;
}
