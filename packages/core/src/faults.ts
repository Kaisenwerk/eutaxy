/**
 * The fault model and the schedule. A schedule is the complete, replayable
 * record of which fault was injected at which effect point in one run.
 */

import { nextFloat, nextInt, type PrngState } from "./prng.ts";

/**
 * `cut_off` is a crash that happens after a response or acknowledgement was
 * already sent, so only background work (ctx.waitUntil) is lost; platforms
 * offer it at the point where that work would start.
 */
export type FaultKind = "crash_before" | "crash_after" | "ambiguous" | "error" | "cut_off";

export const allFaults: readonly FaultKind[] = [
  "crash_before",
  "crash_after",
  "ambiguous",
  "error",
  "cut_off",
];

export interface FaultDecision {
  /** The invocation the effect belongs to, e.g. "msg-1#2". */
  readonly invocation: string;
  /** Position of the effect within that invocation, from 0. Stable when other invocations are removed. */
  readonly ordinal: number;
  readonly fault: FaultKind;
  /** What the effect was, for people reading the schedule. */
  readonly target: string;
  readonly op: string;
}

export interface Schedule {
  /** The per-run seed the decisions were drawn from. */
  readonly seed: number;
  readonly faults: readonly FaultDecision[];
  /**
   * The turn picked at each scheduling decision with more than one option,
   * in order, as an index into the options (parked invocations by start
   * order, then starting the next event). Absent: turns follow the seed.
   * Exhaustive exploration records them, since it picks rather than draws.
   */
  readonly turns?: readonly number[];
}

export interface FaultPolicy {
  readonly maxFaultsPerRun: number;
  /** Probability of injecting at an eligible effect point, in [0, 1]. */
  readonly faultProbability: number;
}

/**
 * Decide whether to inject a fault at an effect point during exploration.
 * Pure: the same state and inputs always give the same decision. The PRNG is
 * only consumed when a fault is possible, so adding an ineligible point does
 * not perturb later decisions.
 */
export function decideFault(
  state: PrngState,
  allowed: readonly FaultKind[],
  faultsSoFar: number,
  policy: FaultPolicy,
): readonly [FaultKind | null, PrngState] {
  if (allowed.length === 0 || faultsSoFar >= policy.maxFaultsPerRun) return [null, state];
  const [p, s1] = nextFloat(state);
  if (p >= policy.faultProbability) return [null, s1];
  const [i, s2] = nextInt(s1, allowed.length);
  return [allowed[i] ?? null, s2];
}
