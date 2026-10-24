/**
 * Constructors for the delivery invariants every platform's scenarios use:
 * nothing delivered twice, nothing lost. Platforms wrap them to take their
 * own drive shapes.
 */

import type { JsonValue } from "./canonical-json.ts";
import {
  type AtLeastOnce,
  type AtMostOncePerKey,
  type EffectSelector,
  getPath,
} from "./invariants.ts";

export function atMostOncePerKey(
  name: string,
  effect: EffectSelector,
  key: string,
): AtMostOncePerKey {
  return { kind: "atMostOncePerKey", name, effect, key };
}

export function atLeastOnce(
  name: string,
  effect: EffectSelector,
  key: string,
  expected: readonly JsonValue[],
): AtLeastOnce {
  return { kind: "atLeastOnce", name, effect, key, expected };
}

/**
 * Every event's `bodyKey` value must appear at least once as `key` in a
 * selected effect. The expected keys are re-derived from the bodies that
 * remain when shrinking removes events.
 */
export function atLeastOncePerMessage(
  name: string,
  events: readonly { readonly id: string; readonly body: JsonValue }[],
  effect: EffectSelector,
  key: string,
  bodyKey: string,
): AtLeastOnce {
  const expected: JsonValue[] = [];
  for (const e of events) {
    const v = getPath(e.body, bodyKey);
    if (v === undefined)
      throw new Error(`event ${e.id} has no ${JSON.stringify(bodyKey)} in its body`);
    expected.push(v);
  }
  return { ...atLeastOnce(name, effect, key, expected), perMessage: { bodyKey } };
}
