/**
 * Pinned schedules: runs a scenario carries, each placing its faults at
 * calls it names by what stays put in a run (a call's target, method and
 * arguments, and its number among the calls that match), so a schedule
 * found once is checked on every run of the command, however the faults
 * placed before a call move the invocations and positions a recorded
 * schedule names.
 */

import { canonicalJson } from "./canonical-json.ts";
import { type FaultSite, faultKinds, siteErrors } from "./fault-sites.ts";
import type { FaultKind } from "./faults.ts";

/** One fault of a pinned schedule: the kind, at the `call`-th call of the run that `at` matches. */
export interface PinnedFault {
  /**
   * The calls it may hit, matched as a fault site matches a point (target,
   * op, `where` and `atLeast` on `args`); its `faults` stays unset, since
   * `fault` names the one kind.
   */
  readonly at: FaultSite;
  /**
   * Which of the calls `at` matches, from 1, in the order the run makes
   * them, counting the points that may take a fault (under the bounds'
   * fault sites, those they leave). Default 1.
   */
  readonly call?: number;
  readonly fault: FaultKind;
}

/**
 * A schedule a scenario carries: its faults, placed in every run of each
 * seed in `seeds` (the run's seed, from which its virtual globals and, with
 * several invocations in flight, its turns are drawn; default `[0]`).
 */
export interface PinnedSchedule {
  /** Names the schedule in the report and the regression test. */
  readonly name: string;
  readonly faults: readonly PinnedFault[];
  readonly seeds?: readonly number[];
  /**
   * The turn picked at each scheduling decision with more than one option,
   * as a recorded schedule has them (see `Schedule.turns`); absent, turns
   * follow the seed. A run that exhaustive exploration picked records them,
   * and the schedule written from it keeps them.
   */
  readonly turns?: readonly number[];
  /**
   * Present when the run the schedule was written from made every
   * asynchronous effect a turn although one invocation ran at a time (see
   * `Schedule.effectsAsTurns`): its runs do the same from their start.
   */
  readonly effectsAsTurns?: true;
}

/** The seeds a pinned schedule runs under. */
export function pinnedSeeds(pinned: PinnedSchedule): readonly number[] {
  return pinned.seeds ?? [0];
}

/** Every reason the pinned schedules are not usable, under `pinned`; empty when they are. */
export function validatePinnedSchedules(pinned: readonly PinnedSchedule[]): readonly string[] {
  if (pinned.length === 0) return ["pinned must name at least one schedule; leave it out for none"];
  const errors: string[] = [];
  const names = new Set<string>();
  pinned.forEach((p, i) => {
    const label = `pinned[${i}]`;
    if (!p.name) errors.push(`${label} needs a name`);
    else if (names.has(p.name)) errors.push(`duplicate pinned schedule ${JSON.stringify(p.name)}`);
    names.add(p.name);
    p.faults.forEach((f, j) => {
      const at = `${label}.faults[${j}]`;
      errors.push(...siteErrors(f.at, `${at}.at`));
      if (f.at.faults !== undefined)
        errors.push(`${at}.at.faults: a pinned fault names its one kind in fault; leave it out`);
      if (!faultKinds.includes(f.fault))
        errors.push(
          `${at}.fault: ${JSON.stringify(f.fault)} is not a fault kind (${faultKinds.join(", ")})`,
        );
      if (f.call !== undefined && !(Number.isInteger(f.call) && f.call >= 1))
        errors.push(`${at}.call counts from 1, got ${String(f.call)}`);
    });
    if (p.seeds !== undefined) {
      if (p.seeds.length === 0)
        errors.push(`${label}.seeds must name at least one seed; leave it out for seed 0`);
      for (const s of p.seeds)
        if (!(Number.isInteger(s) && s >= 0 && s <= 0xffff_ffff))
          errors.push(`${label}.seeds: ${String(s)} is not a run seed (an integer, 0 to 2^32 - 1)`);
    }
    for (const t of p.turns ?? [])
      if (!(Number.isInteger(t) && t >= 0))
        errors.push(`${label}.turns: ${String(t)} is not a turn (an index from 0)`);
    if (p.effectsAsTurns !== undefined && p.effectsAsTurns !== true)
      errors.push(`${label}.effectsAsTurns is true or left out, got ${String(p.effectsAsTurns)}`);
  });
  return errors;
}

/** One pinned fault for people: its kind, the calls it may hit, and which of them. */
export function describePinnedFault(f: PinnedFault): string {
  const { target, op, where, atLeast } = f.at;
  return [
    `${f.fault} at ${target}`,
    op === undefined ? "" : ` ${op}`,
    where === undefined ? "" : ` where ${canonicalJson(where)}`,
    atLeast === undefined ? "" : ` at least ${canonicalJson(atLeast)}`,
    `, call ${f.call ?? 1}`,
  ].join("");
}
