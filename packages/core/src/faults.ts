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

/**
 * The ladders of faults an effect's kind admits, written once; a proxy names
 * one as a point's `allowed` faults. A point with a meaning of its own (the
 * response point, a Workflow step, the background point) lists its own.
 */
/** An effect that may commit and whose answer may be lost: a write, a call into another system, an outbound request. */
export const writeFaults: readonly FaultKind[] = [
  "crash_before",
  "crash_after",
  "ambiguous",
  "error",
];
/** An effect with nothing to be ambiguous about: a read, or a handler run whose failure is seen either way. */
export const readFaults: readonly FaultKind[] = ["crash_before", "crash_after", "error"];
/** A decision a platform records on the invocation's behalf (an ack, a delete): the invocation may die either side of it; it neither errors nor goes missing. */
export const decisionFaults: readonly FaultKind[] = ["crash_before", "crash_after"];

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

/**
 * Where one seeded run injects its faults: with probability `probability`,
 * one up to `maxFaults` distinct positions, in increasing order; otherwise
 * none. Positions count the run's eligible points (those that may take a
 * fault) from 0. The first is uniform over the `baseline` points a run
 * without faults has, which every run reaches before its first fault; the
 * others come after it, uniform up to `longest`, the most any run has had
 * (earlier faults, a redelivery say, can make a run longer). Pure.
 */
export function planFaults(
  state: PrngState,
  baseline: number,
  longest: number,
  maxFaults: number,
  probability: number,
): readonly [readonly number[], PrngState] {
  if (baseline <= 0 || maxFaults <= 0) return [[], state];
  const [p, s1] = nextFloat(state);
  if (p >= probability) return [[], s1];
  let [k, s] = nextInt(s1, maxFaults);
  const more = k;
  let first: number;
  [first, s] = nextInt(s, baseline);
  const room = Math.max(longest, baseline) - first - 1;
  const chosen = new Set<number>([first]);
  while (chosen.size < 1 + Math.min(more, room)) {
    [k, s] = nextInt(s, room);
    chosen.add(first + 1 + k);
  }
  return [[...chosen].sort((a, b) => a - b), s];
}
