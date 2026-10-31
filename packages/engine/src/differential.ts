/**
 * The platform-neutral half of a differential check: the same fault-free
 * scenario once through Eutaxy (this module) and once against the raw
 * bindings (each platform's own, sharing no proxy code), then a comparison
 * of what each attempt decided and of the final state. Any difference is a
 * bug in the proxies or the platform model, not in the handler.
 */

import {
  canonicalJson,
  type DeliveryResult,
  type EffectRecord,
  type EventRef,
  type JsonValue,
  type Platform,
  type ScenarioSpec,
} from "@eutaxy/core";
import { replayChooser } from "./chooser.ts";
import { runOnce } from "./explore.ts";
import { Run } from "./run.ts";

/** The raw side cannot abandon an invocation the way the engine does; a stuck handler ends the comparison. */
export class DifferentialStuck extends Error {
  override readonly name = "DifferentialStuck";
  constructor(
    message = "raw side: the handler is waiting on something outside the run (no effect in flight, no timer due)",
  ) {
    super(message);
  }
}

/**
 * The Eutaxy side: one run with no faults, one event at a time whatever the
 * scenario's bound (the raw side cannot interleave), with `attempt` given
 * each delivery's event, result and log entries.
 */
export async function proxiedSide<A>(
  spec: ScenarioSpec,
  platform: Platform,
  attempt: (event: EventRef, result: DeliveryResult, entries: readonly EffectRecord[]) => A,
): Promise<{ readonly attempts: readonly A[]; readonly unsupported: readonly string[] }> {
  const run = new Run({
    bounds: { ...spec.bounds, maxConcurrentInvocations: 1 },
    chooser: replayChooser({ seed: 0, faults: [] }),
  });
  const attempts: A[] = [];
  // Every member forwarded to the platform itself, so a class's methods keep their `this`.
  const { finish, cleanup } = platform;
  const recording: Platform = {
    name: platform.name,
    assumptions: platform.assumptions,
    ...(platform.concurrent === undefined ? {} : { concurrent: platform.concurrent }),
    reset: (s) => platform.reset(s),
    initialEvents: (s) => platform.initialEvents(s),
    restrictEvents: (s, keep) => platform.restrictEvents(s, keep),
    async deliver(event, hooks, s) {
      const before = run.log.entries.length;
      const result = await platform.deliver(event, hooks, s);
      attempts.push(attempt(event, result, run.log.entries.slice(before)));
      return result;
    },
    ...(finish ? { finish: (s, hooks) => finish.call(platform, s, hooks) } : {}),
    ...(cleanup ? { cleanup: (s) => cleanup.call(platform, s) } : {}),
  };
  await runOnce(spec, recording, run);
  return { attempts, unsupported: run.unsupportedReasons };
}

/**
 * One side's outcome: per-attempt records, and the final state as rows per
 * name. Both are compared as they are, never summarized again, so a
 * difference however deep stays one.
 */
export interface ComparedSide {
  readonly attempts: readonly JsonValue[];
  readonly state: { readonly [name: string]: readonly JsonValue[] };
}

/** Every difference between the two sides, one readable entry each; none means they agree. */
export function compareSides(
  eutaxy: ComparedSide,
  raw: ComparedSide,
  unsupported: readonly string[],
): readonly string[] {
  const differences: string[] = [];
  if (unsupported.length > 0)
    differences.push(`the proxied run touched unsupported APIs: ${unsupported.join("; ")}`);
  const a = canonicalJson(eutaxy.attempts);
  const b = canonicalJson(raw.attempts);
  if (a !== b) differences.push(`attempts differ:\n  eutaxy ${a}\n  raw    ${b}`);
  const names = new Set([...Object.keys(eutaxy.state), ...Object.keys(raw.state)]);
  for (const name of [...names].sort()) {
    const x = canonicalJson(eutaxy.state[name] ?? []);
    const y = canonicalJson(raw.state[name] ?? []);
    if (x !== y) differences.push(`${name} differs:\n  eutaxy ${x}\n  raw    ${y}`);
  }
  return differences;
}
