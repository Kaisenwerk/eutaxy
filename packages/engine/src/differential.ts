/**
 * The platform-neutral part of a differential check: the same fault-free
 * scenario once through Eutaxy and once against the raw bindings, then a
 * comparison of what each attempt decided and of the final state. Any
 * difference is a bug in the proxies or the platform model, not in the
 * handler. The raw side's loop is here too (the same virtual globals and
 * scripted externals as the proxied side, the same pick of the next event
 * and the same redelivery rule); a platform writes only how one raw attempt
 * calls its handler, sharing no proxy code.
 */

import {
  canonicalJson,
  type DeliveryResult,
  type EffectRecord,
  type EventRef,
  earliestEvent,
  type JsonValue,
  type Platform,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { replayChooser } from "./chooser.ts";
import { effectLatencyMs, patchGlobals, settleOn, type VirtualClock } from "./clock.ts";
import type { Outcome } from "./deliver.ts";
import { runOnce } from "./explore.ts";
import { installScriptedFetch } from "./fetch.ts";
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

/** How raw handler code ended: it returned, or it threw. Nothing is injected on the raw side, so nothing crashes. */
export type RawOutcome<T> = Exclude<Outcome<T>, { readonly status: "crashed" }>;

/** What one raw attempt runs under. */
export interface RawContext {
  /** The virtual clock the proxied side's run had, from the same seed; a wrapper advances it as the proxied effect would. */
  readonly clock: VirtualClock;
  /** Real I/O in flight: a wrapper around a real binding or SDK call counts it, so the wait knows the handler is not stuck. */
  readonly io: { n: number };
  /** Run a real call whose library schedules timers of its own with real timers, as the proxied side does. */
  readonly libraryIo: <T>(perform: () => Promise<T>) => Promise<T>;
  /** Report what the raw side could not control; the run ends `DifferentialStuck` with every reason once the attempts are done. */
  readonly unsupported: (reason: string) => void;
  /** Wait for a promise under the virtual clock: real I/O completes, timers fire while the handler is idle, a handler waiting on nothing ends the comparison. */
  readonly settle: <T>(promise: Promise<T>) => Promise<T>;
  /** Run handler code under `settle` to its outcome. */
  readonly call: <T>(code: () => T | Promise<T>) => Promise<RawOutcome<T>>;
}

/** One raw attempt's result: its record, and whether the event was handled (an unhandled one is delivered again while the limits leave room). */
export interface RawAttempt<A> {
  readonly record: A;
  readonly handled: boolean;
}

/** A platform's raw side: its events, its limit on redeliveries, and how one attempt calls the handler. */
export interface RawSide<A> {
  /** The drive's events, as the platform's `initialEvents` gives them. */
  readonly events: readonly EventRef[];
  /** The platform's own limit on redeliveries (Queues' `max_retries`, the caller's `retries`, SQS's `maxReceiveCount` less one). */
  readonly limit: number;
  /**
   * Put in place what the handler needs under the patched globals (the real
   * bindings with their calls counted, an SDK redirected to local clients) and
   * give the attempt; `restore` undoes it after the last attempt, before the
   * globals come back.
   */
  readonly install: (ctx: RawContext) => {
    readonly attempt: (event: EventRef) => Promise<RawAttempt<A>>;
    readonly restore?: () => void;
  };
}

/**
 * The raw side: every event delivered as the engine would deliver it with
 * no faults and one invocation at a time (the earliest due first, time
 * moved to a delayed one, an unhandled one delivered again under core's
 * redelivery rule), each attempt performed by the platform. The attempts'
 * records, in order.
 */
export async function rawRun<A>(spec: ScenarioSpec, side: RawSide<A>): Promise<readonly A[]> {
  // The same virtual globals as the proxied side, from the same seed, so Date.now and randomness agree,
  // and the same scripted externals, without recording.
  const patched = patchGlobals(0);
  const reasons: string[] = [];
  const unsupported = (reason: string): void => {
    reasons.push(reason);
  };
  const restoreFetch = installScriptedFetch(
    spec.externals,
    null,
    unsupported,
    () => patched.clock.advance(effectLatencyMs), // the proxied side advances per effect; match it
  );
  const io = { n: 0 };
  const settle = <T>(promise: Promise<T>): Promise<T> =>
    settleOn(promise, {
      clock: patched.clock,
      inFlight: () => io.n,
      crashed: () => false,
      stuck: () => {
        throw new DifferentialStuck();
      },
    });
  const call = async <T>(code: () => T | Promise<T>): Promise<RawOutcome<T>> => {
    try {
      return { status: "completed", value: await settle(Promise.resolve().then(code)) };
    } catch (error) {
      if (error instanceof DifferentialStuck) throw error;
      return { status: "errored", error };
    }
  };
  const attempts: A[] = [];
  const pending: EventRef[] = [...side.events];
  let restore: (() => void) | undefined;
  try {
    // Inside the cleanup: a platform that finds no handler to call throws here, under the patched globals.
    const installed = side.install({
      clock: patched.clock,
      io,
      libraryIo: (perform) => patched.libraryIo(perform),
      unsupported,
      settle,
      call,
    });
    restore = installed.restore;
    const { attempt } = installed;
    while (pending.length > 0) {
      const [event] = pending.splice(earliestEvent(pending), 1) as [EventRef];
      // The proxied side's clock moved to a delayed event's time; so does this one.
      if (event.at !== undefined && event.at > patched.clock.now())
        patched.clock.advance(event.at - patched.clock.now());
      const { record, handled } = await attempt(event);
      attempts.push(record);
      const next = handled ? null : redelivery(event, side.limit, spec.bounds);
      if (next) pending.push(next);
    }
  } finally {
    restore?.();
    restoreFetch();
    patched.restore();
  }
  if (reasons.length > 0) throw new DifferentialStuck(`raw side: ${reasons.join("; ")}`);
  return attempts;
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
