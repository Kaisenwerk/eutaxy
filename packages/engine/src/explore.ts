/**
 * The exploration loop: run the scenario under seeded fault injection until
 * an invariant breaks or the budget is spent; replay any violation before
 * reporting it.
 */

import {
  type BoundsReached,
  checkInvariants,
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
import { Run } from "./run.ts";
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
}

const engineAssumptions: readonly string[] = [
  "schedule points are effect boundaries: proxied bindings, patched timers and fetch; other awaits run in program order",
  "faults: crash_before, crash_after, ambiguous, error at any effect point; redelivery per the platform's queue model",
  "one invocation at a time (maxConcurrentInvocations = 1)",
  "Date, Math.random, crypto.randomUUID, crypto.getRandomValues, performance.now and timers are virtualised per run from the seed; time starts at 2026-01-01T00:00:00Z and advances 1 ms per effect and to each timer's due time",
  "timers fire only while the invocation is idle (no effect in flight), in due order; an invocation waiting on something outside Eutaxy makes the run UNSUPPORTED",
  "while an effect performs real I/O, timers the library schedules inside that I/O are real (backoff, timeouts) and timers the handler schedules meanwhile stay virtual, told apart by async context; without async context support every timer stays virtual",
  "module-level state cannot be reset between runs; before BOUNDED the first runs are replayed in reverse order and any difference makes the run UNSUPPORTED (module_state_leak)",
  "outbound fetch never reaches the network: requests are answered from the scenario's declared externals, an external's dedupeBy guarantee is honoured by replaying the first response per key, and an undeclared host makes the run UNSUPPORTED",
];

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
      const pending: EventRef[] = [...platform.initialEvents(spec)];
      while (pending.length > 0) {
        const event = pending.shift() as EventRef;
        const result = await platform.deliver(event, run, spec);
        pending.push(...result.followUps);
      }
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
  const assumptions = [...engineAssumptions, ...platform.assumptions];
  const start = now();
  const reached = { runs: 0, effectPoints: 0, faultsInjected: 0 };
  const done = (): BoundsReached => ({ ...reached, elapsedMs: now() - start });
  const base = { scenario: spec.name, seed: options.seed, assumptions };

  if (spec.bounds.maxConcurrentInvocations !== 1) {
    return {
      ...base,
      kind: "UNSUPPORTED",
      cause: "unsupported_bounds",
      reason: "maxConcurrentInvocations above 1 is not supported yet",
      reached: done(),
    };
  }

  const leakCheckRuns = options.leakCheckRuns ?? 2;
  /** The first runs' schedules and digests, replayed in reverse order before BOUNDED. */
  const witnesses: { schedule: Schedule; digest: string }[] = [];

  let master: PrngState = seedPrng(options.seed);
  while (reached.runs < maxRuns && now() - start < spec.bounds.budgetMs) {
    const [runSeed, next] = nextU32(master);
    master = next;
    const run = new Run({
      mode: "explore",
      schedule: { seed: runSeed, faults: [] },
      bounds: spec.bounds,
      faultProbability,
    });
    const log = await runOnce(spec, platform, run);
    reached.runs++;
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
        reached: done(),
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
          reached: done(),
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
        reached: done(),
      };
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
        reached: done(),
      };
    }
  }
  return { ...base, kind: "BOUNDED", bounds: spec.bounds, reached: done() };
}
