/**
 * Shrinking, the pure part: given a violating schedule and the ids of the
 * events that drove it, the candidates to try next, smallest change first.
 * The engine replays each candidate and keeps it when the same invariant is
 * still violated for the same keys.
 */

import type { Schedule } from "./faults.ts";

export interface ShrinkState {
  readonly schedule: Schedule;
  readonly keepIds: readonly string[];
}

/** One-step candidates: each single fault removed, then each single event removed. */
export function shrinkCandidates(state: ShrinkState): readonly ShrinkState[] {
  const out: ShrinkState[] = [];
  state.schedule.faults.forEach((_, i) => {
    out.push({
      schedule: {
        seed: state.schedule.seed,
        faults: state.schedule.faults.filter((_, j) => j !== i),
      },
      keepIds: state.keepIds,
    });
  });
  if (state.keepIds.length > 1) {
    state.keepIds.forEach((id) => {
      out.push({
        schedule: {
          seed: state.schedule.seed,
          // Faults that belonged to the removed event's invocations can no longer fire.
          faults: state.schedule.faults.filter((f) => !f.invocation.startsWith(`${id}#`)),
        },
        keepIds: state.keepIds.filter((k) => k !== id),
      });
    });
  }
  return out;
}

/** Fewer events, then fewer faults: the order that keeps shrinking monotone. */
export function shrinkSize(state: ShrinkState): number {
  return state.keepIds.length * 1000 + state.schedule.faults.length;
}
