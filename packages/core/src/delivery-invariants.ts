/**
 * Constructors for the delivery invariants every platform's scenarios use:
 * nothing delivered twice, nothing lost. Platforms wrap them to take their
 * own drive shapes.
 */

import type { JsonValue } from "./canonical-json.ts";
import type { AtLeastOnce, AtMostOncePerKey } from "./invariants.ts";
import { type EffectSelector, getPath } from "./selectors.ts";

/**
 * No two selected effects share the value at `key` (a dot path into the effect's payload): nothing
 * happened twice for one key, a payment recorded twice, a message sent twice.
 */
export function atMostOncePerKey(
  name: string,
  effect: EffectSelector,
  key: string,
): AtMostOncePerKey {
  return { kind: "atMostOncePerKey", name, effect, key };
}

/** Every value in `expected` appears at least once as `key` in a selected effect: nothing was lost. */
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
