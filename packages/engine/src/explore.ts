/**
 * The exploration loop: run the scenario under seeded fault injection until
 * an invariant breaks or the budget is spent; replay any violation before
 * reporting it.
 */

import {
  type Bounds,
  type BoundsReached,
  checkInvariants,
  type DeliveryResult,
  digestLog,
  type EffectLog,
  type EventRef,
  nextU32,
  type Platform,
  type PrngState,
  type ScenarioSpec,
  type ScenarioVerdict,
  type Schedule,
  seedPrng,
} from "@eutaxy/core";
import { Enumerator } from "./exhaustive.ts";
import { concurrencySupported, Run, type StartedDelivery } from "./run.ts";
import { shrink } from "./shrink.ts";

export interface ExploreOptions {
  readonly seed: number | string;
  /** Hard cap on runs, in addition to the scenario's time budget. */
  readonly maxRuns?: number;
  /** Probability of injecting at an eligible effect point. */
  readonly faultProbability?: number;
  /** Clock for the time budget; injectable for tests. */
  readonly now?: () => number;
  /** Hard cap on replay runs spent shrinking a violation. */
  readonly maxShrinkRuns?: number;
  /**
   * How many of the first exploration runs to replay in reverse order
   * before reporting BOUNDED, to detect module-level state leaking between
   * runs. 0 disables the pass.
   */
  readonly leakCheckRuns?: number;
  /**
   * Explore every schedule within the bounds, each once, instead of drawing
   * schedules from the seed: every fault (or none) at every effect point
   * that may still take one, and every order of turns. With `reduction`
   * (the default), turns of different invocations on different targets
   * commute and only one order of them is run.
   */
  readonly exhaustive?: boolean | { readonly reduction?: boolean };
}

const engineAssumptions: readonly string[] = [
  "schedule points are effect boundaries: proxied bindings, patched timers and fetch; other awaits run in program order",
  "faults: crash_before, crash_after, ambiguous, error at any effect point; redelivery per the platform's queue model",
  "Date, Math.random, crypto.randomUUID, crypto.getRandomValues, performance.now and timers are virtualised per run from the seed; time starts at 2026-01-01T00:00:00Z and advances 1 ms per effect and to each timer's due time",
  "timers fire only while the invocation is idle (no effect in flight), in due order; an invocation waiting on something outside Eutaxy makes the run UNSUPPORTED",
  "an effect whose real I/O takes longer than the scenario's budgetMs is treated as hung: the run is UNSUPPORTED and names the effect",
  "while an effect performs real I/O, timers the library schedules inside that I/O are real (backoff, timeouts) and timers the handler schedules meanwhile stay virtual, told apart by async context; without async context support every timer stays virtual",
  "module-level state cannot be reset between runs; before BOUNDED the first runs are replayed in reverse order and any difference makes the run UNSUPPORTED (module_state_leak)",
  "outbound fetch never reaches the network: requests are answered from the scenario's declared externals, an external's dedupeBy guarantee is honoured by replaying the first response per key, and an undeclared host makes the run UNSUPPORTED",
];

/** What a verdict rests on about concurrency, for these bounds. */
function concurrencyAssumption(bounds: Bounds): string {
  if (bounds.maxConcurrentInvocations === 1)
    return "one invocation at a time (maxConcurrentInvocations = 1)";
  return `up to ${bounds.maxConcurrentInvocations} invocations in flight, interleaved only at asynchronous effects (proxied bindings, fetch): code between two such effects runs without interruption (except continuations of a promise it settles for another invocation, which run then and are still attributed to their own invocation), Web Crypto calls are waited for like I/O, other non-effect awaits (body reads included) settle within one turn of the event loop, synchronous effects are not interleaving points, an effect made by code another effect hosts (an object calling out during a call) is a turn of its own unless that code cannot be interrupted (an object inside blockConcurrencyWhile), when it runs within the hosting effect's turn, the next turn is a seeded pick among parked invocations, whether a new event starts while a slot is free is a seeded pick too, and timers fire only when no invocation can take a turn`;
}

/** The pending event to deliver next: the earliest by `at`, then the first queued. */
function nextEvent(pending: readonly EventRef[]): number {
  let best = 0;
  for (let i = 1; i < pending.length; i++)
    if ((pending[i]?.at ?? 0) < (pending[best]?.at ?? 0)) best = i;
  return best;
}

/** What a verdict rests on about how schedules were chosen, when exploration was exhaustive. */
function explorationAssumption(options: ExploreOptions): readonly string[] {
  if (!options.exhaustive) return [];
  const reduction =
    typeof options.exhaustive === "object" ? (options.exhaustive.reduction ?? true) : true;
  return [
    "exhaustive: every placement of faults within maxFaultsPerRun and every order of turns, each run once, until complete or the budget ends (reached.exhaustive says which)",
    ...(reduction
      ? [
          "partial-order reduction: turns of different invocations whose effects have different targets commute, so one order of them is run; this assumes code between an invocation's effects shares no state with other invocations except through effects and the virtual globals, and once a turn other than an event's start performs an effect on another target than its own, queues an event, or reads virtual time or randomness, or schedules a timer, the reduction is off and every order is run (reached.exhaustive.reduction says whether it stayed on)",
        ]
      : []),
  ];
}

/** Deliver events one at a time, each to completion; time passes until a delayed one is due. */
async function deliverInOrder(spec: ScenarioSpec, platform: Platform, run: Run): Promise<void> {
  const pending: EventRef[] = [...platform.initialEvents(spec)];
  while (pending.length > 0) {
    const [event] = pending.splice(nextEvent(pending), 1) as [EventRef];
    if (event.at !== undefined) await run.advanceTo(event.at);
    const result = await platform.deliver(event, run, spec);
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
 * its next one, or, while a slot is free, the next event starts. When
 * nothing is parked and no event can start a timer fires, and when nothing
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
    if (active.length === 0 && pending.length === 0) return;
    const next = pending.length > 0 ? nextEvent(pending) : -1;
    const due = next >= 0 && (pending[next]?.at ?? 0) <= run.now();
    const canStart = active.length < spec.bounds.maxConcurrentInvocations && due;
    const turn = run.takeTurn(canStart);
    if (turn === "start") {
      const [event] = pending.splice(next, 1) as [EventRef];
      const d: Delivery = {
        started: run.startDelivery(() => platform.deliver(event, run, spec)),
        outcome: null,
      };
      d.started.promise.then(
        (result) => {
          d.outcome = { result };
          run.progressed();
        },
        (error: unknown) => {
          d.outcome = { error };
          run.progressed();
        },
      );
      active.push(d);
    } else if (
      turn === "none" &&
      next >= 0 &&
      !due &&
      active.length < spec.bounds.maxConcurrentInvocations &&
      (run.nextTimerDue() ?? Number.POSITIVE_INFINITY) > (pending[next]?.at ?? 0)
    ) {
      // Nothing can move before the next delayed event is due: let time pass until then.
      await run.advanceTo(pending[next]?.at ?? 0);
    } else if (turn === "none" && !run.fireTimer()) {
      const stuck = active.flatMap((d) => d.started.invocation() ?? []);
      if (run.abandon(stuck) === 0)
        throw new Error(
          `the ${platform.name} platform's delivery made no progress and cannot be abandoned`,
        );
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

/** Re-run a recorded schedule exactly and return the whole run (log and support status). */
export async function replayRun(
  spec: ScenarioSpec,
  platform: Platform,
  schedule: Schedule,
): Promise<Run> {
  const run = new Run({ mode: "replay", schedule, bounds: spec.bounds, faultProbability: 0 });
  await runOnce(spec, platform, run);
  return run;
}

/** Re-run a recorded schedule exactly. */
export async function replay(
  spec: ScenarioSpec,
  platform: Platform,
  schedule: Schedule,
): Promise<EffectLog> {
  return (await replayRun(spec, platform, schedule)).log;
}

export async function explore(
  spec: ScenarioSpec,
  platform: Platform,
  options: ExploreOptions,
): Promise<ScenarioVerdict> {
  const now = options.now ?? (() => Date.now());
  const maxRuns = options.maxRuns ?? 100;
  const faultProbability = options.faultProbability ?? 0.5;
  const assumptions = [
    ...engineAssumptions,
    concurrencyAssumption(spec.bounds),
    ...explorationAssumption(options),
    ...platform.assumptions,
  ];
  const start = now();
  const reached = { runs: 0, effectPoints: 0, faultsInjected: 0 };
  const done = (): BoundsReached => ({ ...reached, elapsedMs: now() - start });
  const base = { scenario: spec.name, seed: options.seed, assumptions };

  if (spec.bounds.maxConcurrentInvocations > 1 && !concurrencySupported) {
    return {
      ...base,
      kind: "UNSUPPORTED",
      cause: "unsupported_bounds",
      reason:
        "maxConcurrentInvocations above 1 needs AsyncLocalStorage (Node, or workerd with nodejs_compat or nodejs_als)",
      reached: done(),
    };
  }
  if (spec.bounds.maxConcurrentInvocations > 1 && !platform.concurrent) {
    return {
      ...base,
      kind: "UNSUPPORTED",
      cause: "unsupported_bounds",
      reason: `maxConcurrentInvocations above 1 is not supported on the ${platform.name} platform yet`,
      reached: done(),
    };
  }

  const leakCheckRuns = options.leakCheckRuns ?? 2;
  /** The first runs' schedules and digests, replayed in reverse order before BOUNDED. */
  const witnesses: { schedule: Schedule; digest: string }[] = [];

  let master: PrngState = seedPrng(options.seed);
  let reduction =
    typeof options.exhaustive === "object" ? (options.exhaustive.reduction ?? true) : true;
  let enumerator = options.exhaustive ? new Enumerator({ reduction }) : null;
  let schedules = 0;
  let more = true;
  let restart = false;
  const exhaustiveReached = () =>
    enumerator ? { exhaustive: { complete: !more, schedules, reduction } } : {};
  const doneNow = (): BoundsReached => ({ ...done(), ...exhaustiveReached() });
  while (more && reached.runs < maxRuns && now() - start < spec.bounds.budgetMs) {
    const [runSeed, next] = nextU32(master);
    master = next;
    const run = new Run({
      mode: "explore",
      // Enumerated runs pick their choices; they share one seed for the virtual globals.
      schedule: { seed: enumerator ? 0 : runSeed, faults: [] },
      bounds: spec.bounds,
      faultProbability,
      ...(enumerator ? { chooser: enumerator.next() } : {}),
    });
    const log = await runOnce(spec, platform, run);
    reached.runs++;
    if (enumerator) {
      if (enumerator.mismatch) {
        return {
          ...base,
          kind: "UNSUPPORTED",
          cause: "not_replayable",
          reason: `exhaustive exploration needs deterministic runs: ${enumerator.mismatch}`,
          reached: doneNow(),
        };
      }
      // The reduction's commuting turns do not commute here: once this run is checked, every order.
      restart = reduction && run.turnsMayNotCommute;
      if (!restart) {
        more = enumerator.advance();
        // A run the reduction had already covered is not a new schedule; its checks repeat others'.
        if (enumerator.blocked) continue;
      }
      schedules++;
    }
    reached.effectPoints += run.effectPoints;
    reached.faultsInjected += run.faultsInjected;
    if (witnesses.length < leakCheckRuns)
      witnesses.push({ schedule: run.schedule, digest: digestLog(log) });

    if (run.unsupportedReasons.length > 0) {
      return {
        ...base,
        kind: "UNSUPPORTED",
        cause: "unsupported_api",
        reason: run.unsupportedReasons.join("; "),
        reached: doneNow(),
      };
    }

    const violations = checkInvariants(log, spec.invariants);
    const violation = violations[0];
    if (violation) {
      const schedule = run.schedule;
      const replayedRun = await replayRun(spec, platform, schedule);
      const replayed = replayedRun.log;
      reached.runs++;
      if (replayedRun.unsupportedReasons.length > 0 || digestLog(replayed) !== digestLog(log)) {
        return {
          ...base,
          kind: "UNSUPPORTED",
          cause: "not_replayable",
          reason: `the violating run of seed ${schedule.seed} did not reproduce on replay`,
          reached: doneNow(),
        };
      }
      // Shrink within the scenario's budget (a second budget's worth at most), then report.
      const shrunk = await shrink(spec, platform, schedule, violation, replayed, {
        maxRuns: options.maxShrinkRuns ?? 200,
        deadline: now() + spec.bounds.budgetMs,
        now,
      });
      reached.runs += shrunk.runs;
      return {
        ...base,
        kind: "VIOLATED",
        violation: shrunk.violation,
        trace: shrunk.trace,
        schedule: shrunk.schedule,
        keptEvents: shrunk.keptEvents,
        shrunk: {
          faultsRemoved: shrunk.faultsRemoved,
          eventsRemoved: shrunk.eventsRemoved,
          runs: shrunk.runs,
        },
        reached: doneNow(),
      };
    }
    if (restart) {
      reduction = false;
      enumerator = new Enumerator({ reduction });
      schedules = 0;
    }
  }
  // Module-state leak detection: the same schedules, in the opposite order, must give the same logs.
  for (const witness of [...witnesses].reverse()) {
    const again = await replayRun(spec, platform, witness.schedule);
    reached.runs++;
    if (again.unsupportedReasons.length > 0 || digestLog(again.log) !== witness.digest) {
      return {
        ...base,
        kind: "UNSUPPORTED",
        cause: "module_state_leak",
        reason: `run seed ${witness.schedule.seed} produced a different log when replayed after other runs: state is leaking between runs (module-level variables, or a binding Eutaxy does not reset)`,
        reached: doneNow(),
      };
    }
  }
  return { ...base, kind: "BOUNDED", bounds: spec.bounds, reached: doneNow() };
}
