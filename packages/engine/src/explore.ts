/**
 * The exploration loop: run the scenario under seeded fault injection until
 * an invariant breaks or the budget is spent; replay any violation before
 * reporting it.
 */

import {
  type Bounds,
  type BoundsReached,
  canonicalJson,
  checkInvariants,
  type DeliveryResult,
  type EffectLog,
  type EffectRecord,
  type EventRef,
  earliestEvent,
  type JsonValue,
  nextU32,
  type Platform,
  type PrngState,
  planFaults,
  type ScenarioSpec,
  type ScenarioVerdict,
  type Schedule,
  seedPrng,
  serializeLog,
  type UnsupportedCause,
} from "@eutaxy/core";
import { replayChooser, seededChooser } from "./chooser.ts";
import { ExhaustiveDriver } from "./exhaustive.ts";
import { concurrencySupported, Run, type StartedDelivery } from "./run.ts";
import { shrink } from "./shrink.ts";

/** How `explore` searches: the seed, a cap on runs, the time budget, the share of runs with faults, and exhaustive mode. */
export interface ExploreOptions {
  readonly seed: number | string;
  /** Hard cap on runs, in addition to the scenario's time budget. */
  readonly maxRuns?: number;
  /**
   * Replaces the scenario's `budgetMs` for this exploration: the real time
   * exploring and shrinking may take, and the real time one effect's I/O
   * may take before it counts as hung. With a generous budget and
   * `maxRuns`, the run cap ends exploration, so a seed decides the verdict
   * on any machine.
   */
  readonly budgetMs?: number;
  /**
   * The share of seeded runs after the first (which injects none) that
   * inject faults (see `planFaults`). Default 0.9: the runs without faults
   * also check the scenario as it runs without them, and measure how many
   * eligible points a run without faults has, which can vary with the seed.
   */
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
  "timers fire in due order; one at a time, only while the invocation is idle (no effect in flight); with several in flight, as the concurrency assumption says; an invocation waiting on something outside Eutaxy makes the run UNSUPPORTED",
  "an effect whose real I/O takes longer than the time budget (the scenario's budgetMs, or the budgetMs option replacing it) is treated as hung: the run is UNSUPPORTED and names the effect",
  "while an effect performs real I/O, timers the library schedules inside that I/O are real (backoff, timeouts) and timers the handler schedules meanwhile stay virtual, told apart by async context; without async context support every timer stays virtual",
  "module-level state cannot be reset between runs; before BOUNDED the first runs are replayed in reverse order and any difference makes the run UNSUPPORTED (module_state_leak)",
  "outbound fetch never reaches the network: requests are answered from the scenario's declared externals, an external's dedupeBy guarantee is honoured by replaying the first response per key, and an undeclared host makes the run UNSUPPORTED",
];

/** What a verdict rests on about concurrency, for these bounds. */
function concurrencyAssumption(bounds: Bounds): string {
  if (bounds.maxConcurrentInvocations === 1)
    return "one invocation at a time (maxConcurrentInvocations = 1)";
  return `up to ${bounds.maxConcurrentInvocations} invocations in flight, interleaved only at asynchronous effects (proxied bindings, fetch): code between two such effects runs without interruption (except continuations of a promise it settles for another invocation, which run then and are still attributed to their own invocation), Web Crypto calls are waited for like I/O, other non-effect awaits (body reads included) settle within one turn of the event loop, synchronous effects are not interleaving points, an effect made by code another effect hosts (an object calling out during a call) is a turn of its own unless that code cannot be interrupted (an object inside blockConcurrencyWhile), when it runs within the hosting effect's turn, the next turn is a seeded pick among parked invocations, starting a new event while a slot is free, and firing the earliest timer already due (at or before the virtual now, which effects advance), timers firing in due order among themselves, and a timer not yet due fires (virtual time passing to it) only when nothing else can move`;
}

/** Where two JSON values first differ, as a path into them (`.tables.audit[0].at`), with the two values there. */
function firstDifference(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
  path = "",
): { path: string; a: JsonValue | undefined; b: JsonValue | undefined } | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const record = (v: unknown): v is { readonly [key: string]: JsonValue } =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (record(a) && record(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[key], b[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  const same = a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
  return same ? null : { path, a, b };
}

/**
 * The first record a replay recorded differently from the run, or how their
 * lengths differ; null when the logs match. Two records of the same effect
 * are told apart by the first value in their payloads that differs, with its
 * path: a snapshot of many tables that differs in one column says which.
 */
function whatDiffered(run: EffectLog, replay: EffectLog): string | null {
  const short = (v: JsonValue | undefined): string => {
    if (v === undefined) return "nothing";
    const text = canonicalJson(v);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  };
  /** Two differing values, each cut to the stretch around where their texts part, so the excerpts differ too. */
  const apart = (x: JsonValue | undefined, y: JsonValue | undefined): [string, string] => {
    if (x === undefined || y === undefined) return [short(x), short(y)];
    const [s, t] = [canonicalJson(x), canonicalJson(y)];
    if (s.length <= 120 && t.length <= 120) return [s, t];
    let at = 0;
    while (at < s.length && at < t.length && s[at] === t[at]) at++;
    const from = Math.max(0, at - 40);
    const cut = (text: string): string =>
      `${from > 0 ? "..." : ""}${text.slice(from, from + 110)}${from + 110 < text.length ? "..." : ""}`;
    return [cut(s), cut(t)];
  };
  const head = (e: EffectRecord): string => `${e.kind} ${e.target} ${e.op} in ${e.invocation}`;
  const a = serializeLog(run).split("\n");
  const b = serializeLog(replay).split("\n");
  const n = Math.min(run.entries.length, replay.entries.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const ran = run.entries[i] as EffectRecord;
    const replayed = replay.entries[i] as EffectRecord;
    const within = head(ran) === head(replayed) && firstDifference(ran.payload, replayed.payload);
    if (within) {
      const [was, is] = apart(within.a, within.b);
      return `at seq ${i} the run recorded ${head(ran)} with ${was} at payload${within.path} and the replay with ${is}`;
    }
    return `at seq ${i} the run recorded ${head(ran)} ${short(ran.payload)} and the replay ${head(replayed)} ${short(replayed.payload)}`;
  }
  if (run.entries.length === replay.entries.length) return null;
  return `the run recorded ${run.entries.length} entries and the replay ${replay.entries.length}`;
}

/** Whether exhaustive exploration reduces by partial order (it does unless told not to). */
function reductionOf(options: ExploreOptions): boolean {
  return typeof options.exhaustive === "object" ? (options.exhaustive.reduction ?? true) : true;
}

/** What a verdict rests on about how schedules were chosen, when exploration was exhaustive. */
function explorationAssumption(options: ExploreOptions): readonly string[] {
  if (!options.exhaustive) return [];
  const reduction = reductionOf(options);
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
    if (active.length === 0 && pending.length === 0 && !run.hasAfterWork()) return;
    const next = pending.length > 0 ? earliestEvent(pending) : -1;
    const eventAt = pending[next]?.at ?? 0;
    const due = next >= 0 && eventAt <= run.now();
    const canStart = active.length < spec.bounds.maxConcurrentInvocations && due;
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

/** Re-run a recorded schedule exactly and return the whole run (log and support status). */
export async function replayRun(
  spec: ScenarioSpec,
  platform: Platform,
  schedule: Schedule,
): Promise<Run> {
  const run = new Run({ bounds: spec.bounds, chooser: replayChooser(schedule) });
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

/**
 * Explore a scenario on a platform: run it under schedules drawn from the seed (or every schedule within
 * the bounds, when exhaustive), shrink the first violation found, and return the verdict. At most 100 runs
 * unless `maxRuns` says otherwise.
 */
export async function explore(
  scenario: ScenarioSpec,
  platform: Platform,
  options: ExploreOptions,
): Promise<ScenarioVerdict> {
  const budgetMs = options.budgetMs;
  if (budgetMs !== undefined && !(Number.isFinite(budgetMs) && budgetMs > 0))
    throw new Error(`budgetMs must be a positive finite number, got ${budgetMs}`);
  const spec =
    budgetMs === undefined ? scenario : { ...scenario, bounds: { ...scenario.bounds, budgetMs } };
  const now = options.now ?? (() => Date.now());
  const maxRuns = options.maxRuns ?? 100;
  // The runs kept fault-free re-measure the path without faults, which can vary with the seed.
  const faultProbability = options.faultProbability ?? 0.9;
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
  const exhaustive = options.exhaustive
    ? new ExhaustiveDriver(reductionOf(options), spec.bounds.maxFaultsPerRun)
    : null;
  const doneNow = (): BoundsReached => ({
    ...done(),
    ...(exhaustive ? { exhaustive: exhaustive.reached } : {}),
  });
  const unsupported = (cause: UnsupportedCause, reason: string): ScenarioVerdict => ({
    ...base,
    kind: "UNSUPPORTED",
    cause,
    reason,
    reached: doneNow(),
  });

  if (spec.bounds.maxConcurrentInvocations > 1 && !concurrencySupported)
    return unsupported(
      "unsupported_bounds",
      "maxConcurrentInvocations above 1 needs AsyncLocalStorage (Node, or workerd with nodejs_compat or nodejs_als)",
    );
  if (spec.bounds.maxConcurrentInvocations > 1 && !platform.concurrent)
    return unsupported(
      "unsupported_bounds",
      `maxConcurrentInvocations above 1 is not supported on the ${platform.name} platform yet`,
    );

  const leakCheckRuns = options.leakCheckRuns ?? 2;
  /** The first runs' schedules and digests, replayed in reverse order before BOUNDED. */
  const witnesses: { schedule: Schedule; log: EffectLog }[] = [];

  let master: PrngState = seedPrng(options.seed);
  /** Eligible points of a run without faults, and the most any run has had: seeded fault positions. */
  let baseline = 0;
  let longest = 0;
  while (
    (exhaustive?.hasMore ?? true) &&
    reached.runs < maxRuns &&
    now() - start < spec.bounds.budgetMs
  ) {
    const [runSeed, next] = nextU32(master);
    master = next;
    // Seeded runs fault positions drawn over the eligible points seen so far: none before any is.
    let faultPlan: readonly number[] = [];
    if (!exhaustive) {
      [faultPlan, master] = planFaults(
        master,
        baseline,
        longest,
        spec.bounds.maxFaultsPerRun,
        faultProbability,
      );
    }
    const run = new Run({
      bounds: spec.bounds,
      chooser: exhaustive
        ? exhaustive.next()
        : seededChooser(runSeed, {
            faultPlan,
            faultProbability,
            maxFaultsPerRun: spec.bounds.maxFaultsPerRun,
          }),
    });
    const log = await runOnce(spec, platform, run);
    reached.runs++;
    if (run.faultsInjected === 0) baseline = Math.max(baseline, run.eligiblePoints);
    longest = Math.max(longest, run.eligiblePoints);
    if (exhaustive) {
      if (exhaustive.mismatch)
        return unsupported(
          "not_replayable",
          `exhaustive exploration needs deterministic runs: ${exhaustive.mismatch}`,
        );
      if (!exhaustive.ran(() => run.turnsMayNotCommute)) continue;
    }
    reached.effectPoints += run.effectPoints;
    reached.faultsInjected += run.faultsInjected;
    if (witnesses.length < leakCheckRuns) witnesses.push({ schedule: run.schedule, log });

    if (run.unsupportedReasons.length > 0)
      return unsupported("unsupported_api", run.unsupportedReasons.join("; "));

    const violations = checkInvariants(log, spec.invariants);
    const violation = violations[0];
    if (violation) {
      const schedule = run.schedule;
      const replayedRun = await replayRun(spec, platform, schedule);
      const replayed = replayedRun.log;
      reached.runs++;
      // A replay that reached something unsupported says so itself; one that differs says where.
      if (replayedRun.unsupportedReasons.length > 0)
        return unsupported("unsupported_api", replayedRun.unsupportedReasons.join("; "));
      const differed = whatDiffered(log, replayed);
      if (differed)
        return unsupported(
          "not_replayable",
          `the violating run of seed ${schedule.seed} did not reproduce on replay: ${differed}`,
        );
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
    exhaustive?.checked();
  }
  // Module-state leak detection: the same schedules, in the opposite order, must give the same logs.
  for (const witness of [...witnesses].reverse()) {
    const again = await replayRun(spec, platform, witness.schedule);
    reached.runs++;
    if (again.unsupportedReasons.length > 0)
      return unsupported("unsupported_api", again.unsupportedReasons.join("; "));
    const differed = whatDiffered(witness.log, again.log);
    if (differed)
      return unsupported(
        "module_state_leak",
        `run seed ${witness.schedule.seed} produced a different log when replayed after other runs: state is leaking between runs (module-level variables, or a binding Eutaxy does not reset); ${differed}`,
      );
  }
  return { ...base, kind: "BOUNDED", bounds: spec.bounds, reached: doneNow() };
}
