/** Simulation verdicts, with what each one rests on. */

import type { EffectLog } from "./effect-log.ts";
import type { Schedule } from "./faults.ts";
import type { PinnedSchedule } from "./pinned-schedules.ts";
import type { Bounds } from "./scenario.ts";
import type { Violation } from "./violation.ts";

/** How far exploration got: runs, effect points, faults injected and time taken, and coverage when exhaustive. */
export interface BoundsReached {
  readonly runs: number;
  readonly effectPoints: number;
  readonly faultsInjected: number;
  readonly elapsedMs: number;
  /**
   * Present when exploration was exhaustive: how many distinct schedules ran
   * (runs that only repeated an order the reduction had covered are not
   * counted), and whether every schedule within the bounds was reached
   * before the budget ran out.
   */
  readonly exhaustive?: {
    readonly complete: boolean;
    readonly schedules: number;
    readonly reduction: boolean;
  };
}

interface VerdictBase {
  readonly scenario: string;
  readonly seed: number | string;
  readonly reached: BoundsReached;
  readonly assumptions: readonly string[];
}

export interface Shrunk {
  readonly faultsRemoved: number;
  readonly eventsRemoved: number;
  readonly runs: number;
}

/** An invariant broke: the violation, the shrunk schedule that reproduces it and its trace. */
export interface Violated extends VerdictBase {
  readonly kind: "VIOLATED";
  readonly violation: Violation;
  /** The replayed, shrunk trace that breaks the invariant. */
  readonly trace: EffectLog;
  readonly schedule: Schedule;
  /** Ids of the drive's events that remain after shrinking. */
  readonly keptEvents: readonly string[];
  readonly shrunk: Shrunk;
  /**
   * The name of the scenario's pinned schedule whose run broke the
   * invariant; its schedule is that run's, as it ran (not shrunk). Absent
   * when exploration found it.
   */
  readonly pinned?: string;
  /** The pinned schedule's faults its run did not place, each with why; absent when it placed them all. */
  readonly unplaced?: readonly string[];
}

/** No violation within the stated bounds; not a proof. */
export interface Bounded extends VerdictBase {
  readonly kind: "BOUNDED";
  readonly bounds: Bounds;
}

export type UnsupportedCause =
  | "unsupported_api"
  | "not_replayable"
  | "module_state_leak"
  | "unsupported_bounds"
  | "pin_not_placed";

/** The run did something the simulation cannot control or replay, so no claim is made: the cause and the reason. */
export interface Unsupported extends VerdictBase {
  readonly kind: "UNSUPPORTED";
  readonly cause: UnsupportedCause;
  readonly reason: string;
  /**
   * The schedule of the run that reached it, to replay; absent where no run
   * was made (`unsupported_bounds`). It is the run's own, not shrunk. A run
   * that ended on real time (an effect that outlasted the budget, code
   * waiting on something outside the simulation) may not end at the same
   * place when replayed.
   */
  readonly schedule?: Schedule;
  /**
   * For `unsupported_api`, the same run as a pinned schedule, present once
   * that run replayed alone reached the same reason again: each fault
   * at the call it hit, by its target, op and arguments and that call's
   * number among the run's matching calls, under the run's seed (and its
   * turns when it recorded them), so a replay still finds the call when
   * the faults or effects before it move invocations and positions.
   */
  readonly replay?: PinnedSchedule;
}

/** A scenario's verdict: `VIOLATED`, `BOUNDED` or `UNSUPPORTED`. */
export type ScenarioVerdict = Violated | Bounded | Unsupported;

/** One line per verdict, for error messages; full rendering lives in `report`. */
export function describeVerdict(v: ScenarioVerdict): string {
  switch (v.kind) {
    case "VIOLATED":
      return `VIOLATED ${v.scenario}: ${v.violation.message} (seed ${v.schedule.seed}, ${v.reached.runs} run(s))`;
    case "BOUNDED":
      return `BOUNDED ${v.scenario}: no violation in ${v.reached.runs} run(s), ${v.reached.effectPoints} effect point(s), ${v.reached.faultsInjected} fault(s)`;
    case "UNSUPPORTED":
      return `UNSUPPORTED ${v.scenario}: ${v.cause}: ${v.reason}`;
  }
}
