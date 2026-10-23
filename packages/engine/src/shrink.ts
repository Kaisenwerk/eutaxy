/**
 * Shrinking, the loop: try the pure candidates in order, replay each, keep
 * the first that still violates the same invariant for the same keys, and
 * repeat from there until nothing smaller works or the budget is spent.
 */

import {
  checkInvariants,
  type EffectLog,
  type Platform,
  recomputePerMessageExpected,
  type ScenarioSpec,
  type Schedule,
  type ShrinkState,
  sameViolation,
  shrinkCandidates,
  type Violation,
} from "@eutaxy/core";
import { replayRun } from "./explore.ts";

export interface ShrinkOptions {
  readonly maxRuns: number;
  readonly deadline: number;
  readonly now: () => number;
}

export interface ShrinkResult {
  readonly spec: ScenarioSpec;
  readonly schedule: Schedule;
  readonly keptEvents: readonly string[];
  readonly trace: EffectLog;
  readonly violation: Violation;
  readonly runs: number;
  readonly faultsRemoved: number;
  readonly eventsRemoved: number;
}

/** The scenario restricted to the kept events, with per-message invariants re-derived. */
export function restrictSpec(
  platform: Platform,
  spec: ScenarioSpec,
  keepIds: readonly string[],
): ScenarioSpec {
  const restricted = platform.restrictEvents(spec, keepIds);
  const bodies = platform.initialEvents(restricted).map((e) => e.data);
  return { ...restricted, invariants: recomputePerMessageExpected(restricted.invariants, bodies) };
}

export async function shrink(
  spec: ScenarioSpec,
  platform: Platform,
  schedule: Schedule,
  violation: Violation,
  trace: EffectLog,
  options: ShrinkOptions,
): Promise<ShrinkResult> {
  const allIds = platform.initialEvents(spec).map((e) => e.id);
  let state: ShrinkState = { schedule, keepIds: allIds };
  let best = { trace, violation };
  let runs = 0;

  let improved = true;
  while (improved && runs < options.maxRuns && options.now() < options.deadline) {
    improved = false;
    for (const candidate of shrinkCandidates(state)) {
      if (runs >= options.maxRuns || options.now() >= options.deadline) break;
      const candidateSpec = restrictSpec(platform, spec, candidate.keepIds);
      const run = await replayRun(candidateSpec, platform, candidate.schedule);
      const log = run.log;
      runs++;
      // A smaller run that touches something Eutaxy cannot control is not a valid counterexample.
      if (run.unsupportedReasons.length > 0) continue;
      const found = checkInvariants(log, candidateSpec.invariants).find((v) =>
        sameViolation(v, violation),
      );
      if (found) {
        state = candidate;
        best = { trace: log, violation: found };
        improved = true;
        break;
      }
    }
  }
  return {
    spec: restrictSpec(platform, spec, state.keepIds),
    schedule: state.schedule,
    keptEvents: state.keepIds,
    trace: best.trace,
    violation: best.violation,
    runs,
    faultsRemoved: schedule.faults.length - state.schedule.faults.length,
    eventsRemoved: allIds.length - state.keepIds.length,
  };
}
