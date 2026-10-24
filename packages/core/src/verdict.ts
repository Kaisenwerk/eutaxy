/** Simulation verdicts, with what each one rests on. */

import type { EffectLog } from "./effect-log.ts";
import type { Schedule } from "./faults.ts";
import type { Violation } from "./invariants.ts";
import type { Bounds } from "./scenario.ts";

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

export interface Violated extends VerdictBase {
  readonly kind: "VIOLATED";
  readonly violation: Violation;
  /** The replayed, shrunk trace that breaks the invariant. */
  readonly trace: EffectLog;
  readonly schedule: Schedule;
  /** Ids of the drive's events that remain after shrinking. */
  readonly keptEvents: readonly string[];
  readonly shrunk: Shrunk;
}

export interface Bounded extends VerdictBase {
  readonly kind: "BOUNDED";
  readonly bounds: Bounds;
}

export type UnsupportedCause =
  | "unsupported_api"
  | "not_replayable"
  | "module_state_leak"
  | "unsupported_bounds";

export interface Unsupported extends VerdictBase {
  readonly kind: "UNSUPPORTED";
  readonly cause: UnsupportedCause;
  readonly reason: string;
}

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
