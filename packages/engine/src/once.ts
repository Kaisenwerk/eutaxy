/**
 * One run of a scenario from reset to its log: the events delivered one at
 * a time, or with several invocations in flight and each turn the run's
 * pick (`runOnce`), and a recorded schedule run again exactly
 * (`replayRun`). Exploring and shrinking both stand on these.
 */

import {
  type DeliveryResult,
  type EffectLog,
  type EventRef,
  earliestEvent,
  type Platform,
  type ScenarioSpec,
  type Schedule,
} from "@eutaxy/core";
import { replayChooser } from "./chooser.ts";
import { concurrencySupported, Run, type StartedDelivery } from "./run.ts";

/** Deliver events one at a time, each to completion; time passes until a delayed one is due. */
async function deliverInOrder(spec: ScenarioSpec, platform: Platform, run: Run): Promise<void> {
  const pending: EventRef[] = [...platform.initialEvents(spec)];
  for (;;) {
    // Every event delivered and nothing left to move: the platform's own closing events, if any.
    if (pending.length === 0) pending.push(...(platform.closingEvents?.(spec) ?? []));
    if (pending.length === 0) return;
    const [event] = pending.splice(earliestEvent(pending), 1) as [EventRef];
    if (event.at !== undefined) await run.advanceTo(event.at);
    const result = await platform.deliver(event, run, spec);
    // An object's work after its answer runs to rest before the next event, one of the orders the
    // runtime allows (a concurrent run explores the others).
    await run.driveAfterWork();
    pending.push(...run.takeQueued(), ...result.followUps);
  }
}

interface Delivery {
  readonly started: StartedDelivery<DeliveryResult>;
  outcome: { readonly result: DeliveryResult } | { readonly error: unknown } | null;
}

/**
 * Deliver events with up to `maxConcurrentInvocations` in flight. Each turn
 * is a seeded pick: one parked invocation performs its effect and runs to
 * its next one, while a slot is free the next event starts, or a timer
 * already due fires. When nothing is parked, no event can start and no
 * timer is due, the next timer fires (time passes to it), and when nothing
 * can move the remaining invocations are abandoned.
 */
async function deliverConcurrently(
  spec: ScenarioSpec,
  platform: Platform,
  run: Run,
): Promise<void> {
  const pending: EventRef[] = [...platform.initialEvents(spec)];
  let active: Delivery[] = [];
  for (;;) {
    // Finished deliveries leave in the order they started; their follow-ups queue behind the rest.
    const queuedBefore = pending.length;
    for (const d of active) {
      if (!d.outcome) continue;
      if ("error" in d.outcome) throw d.outcome.error;
      pending.push(...d.outcome.result.followUps);
    }
    active = active.filter((d) => !d.outcome);
    pending.push(...run.takeQueued());
    if (pending.length > queuedBefore) run.queuedEvents();
    if (active.length === 0 && pending.length === 0 && !run.hasAfterWork()) {
      // Every event delivered and nothing left to move: the platform's own closing events, if any.
      pending.push(...(platform.closingEvents?.(spec) ?? []));
      if (pending.length === 0) return;
      run.queuedEvents();
    }
    const next = pending.length > 0 ? earliestEvent(pending) : -1;
    const eventAt = pending[next]?.at ?? 0;
    const due = next >= 0 && eventAt <= run.now();
    // One invocation at a time (a run whose effects are turns for an invocation's parallel calls):
    // an object's work after its answer runs to rest before the next event starts, as
    // `deliverInOrder` has it.
    const resting = spec.bounds.maxConcurrentInvocations === 1 && run.hasAfterWork();
    const canStart = active.length < spec.bounds.maxConcurrentInvocations && due && !resting;
    // While only objects' work after their answers is alive, only its timers are ready work (see below).
    const afterWorkOnly = active.length === 0 && run.hasAfterWork();
    // What the loop does when nothing is parked: time passes to the next delayed event when nothing
    // can move before it, else the next timer fires. Offered as a turn while only late turns are parked.
    const timerDue = run.nextTimerDue(afterWorkOnly);
    const untilEvent =
      next >= 0 &&
      !due &&
      active.length < spec.bounds.maxConcurrentInvocations &&
      (timerDue ?? Number.POSITIVE_INFINITY) > eventAt;
    const turn = run.takeTurn(canStart, afterWorkOnly, untilEvent || timerDue !== undefined);
    if (turn === "start") {
      const [event] = pending.splice(next, 1) as [EventRef];
      const d: Delivery = {
        started: run.startDelivery(() => platform.deliver(event, run, spec)),
        outcome: null,
      };
      d.started.promise.then(
        (result) => {
          d.outcome = { result };
          run.rested();
        },
        (error: unknown) => {
          d.outcome = { error };
          run.rested();
        },
      );
      active.push(d);
    } else if (turn === "none" && untilEvent) {
      // Nothing can move before the next delayed event is due: let time pass until then. With no
      // timer fired on the way, nothing was set off that a wait could settle.
      if (!(await run.advanceTo(eventAt))) continue;
    } else if (
      turn === "none" &&
      !(active.length > 0 || !run.hasAfterWork() ? run.fireTimer() : run.fireAfterWorkTimer()) &&
      run.settleAfterWork() === 0
    ) {
      // Nothing can move: objects' work after their answers has settled; anything else is stuck. While
      // only such work is alive its own timers fire, not a finished handler's stray one, which would
      // keep it alive; with no such work, timers fire as before (a stray one until the next event is due).
      const stuck = active.flatMap((d) => d.started.invocation() ?? []);
      if (run.abandon(stuck) === 0) {
        // A delivery whose invocation has crashed is the platform's to end, and what it does after a
        // crash is its own work outside any effect (evicting the object the crash reset takes real
        // time): waited for, within the budget. Anything else left here cannot move at all.
        const ending = active.filter((d) => run.hasCrashed(d.started.invocation()));
        if (!(await run.ended(ending.map((d) => d.started.promise))))
          throw new Error(
            `the ${platform.name} platform's delivery made no progress and cannot be abandoned`,
          );
      }
    }
    await run.quiesce();
  }
}

/** Run the scenario once under the given run's fault decisions and return its log. */
export async function runOnce(
  spec: ScenarioSpec,
  platform: Platform,
  run: Run,
): Promise<EffectLog> {
  // Reset and the end-of-run snapshot are platform work, not user code: they run with the real
  // globals, so an in-process local service (which shares them) keeps its own timers.
  await platform.reset(spec);
  run.install(spec.externals);
  try {
    try {
      if (!run.concurrent) await deliverInOrder(spec, platform, run);
      else if (platform.concurrent) await deliverConcurrently(spec, platform, run);
      else throw new Error(`the ${platform.name} platform delivers one event at a time`);
    } finally {
      run.uninstall();
    }
    await platform.finish?.(spec, run);
  } finally {
    // Whatever happened above, the platform undoes its per-run patching.
    await platform.cleanup?.(spec);
  }
  return run.log;
}

/**
 * Whether a run on this platform can make every effect a turn: the host
 * carries async context and the platform delivers with several invocations
 * in flight. One invocation at a time needs the same once its calls run in
 * parallel (`Run.parallelCalls`).
 */
export function takesTurns(platform: Platform): boolean {
  return concurrencySupported && platform.concurrent === true;
}

/** Refuse a schedule recorded with every effect a turn on a platform or a host that cannot run it so. */
export function mustTakeTurns(platform: Platform, what: string): void {
  if (takesTurns(platform)) return;
  throw new Error(
    `${what} was recorded with every effect a turn (effectsAsTurns), which ${cannotTakeTurns(platform)}`,
  );
}

/** Why effects cannot be turns here, for a reason; call only where `takesTurns` is false. */
export function cannotTakeTurns(platform: Platform): string {
  return concurrencySupported
    ? `the ${platform.name} platform cannot do: it delivers one event at a time`
    : "needs AsyncLocalStorage (Node, or workerd with nodejs_compat or nodejs_als)";
}

/**
 * Re-run a recorded schedule exactly and return the whole run (log and
 * support status): with every effect a turn where the schedule says its run
 * had them so (`Schedule.effectsAsTurns`). A schedule that does not say so,
 * replayed in a run that shows an invocation's calls in parallel, is run
 * again that way where the platform can: `explore` would have recorded it so.
 */
export async function replayRun(
  spec: ScenarioSpec,
  platform: Platform,
  schedule: Schedule,
): Promise<Run> {
  const turns = schedule.effectsAsTurns === true;
  if (turns) mustTakeTurns(platform, "the schedule");
  const run = new Run({ bounds: spec.bounds, chooser: replayChooser(schedule), turns });
  await runOnce(spec, platform, run);
  if (!turns && run.parallelCalls?.turnsWouldOrder === true && takesTurns(platform))
    return replayRun(spec, platform, { ...schedule, effectsAsTurns: true });
  return run;
}
