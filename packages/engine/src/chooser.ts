/**
 * How a run chooses. A run's nondeterminism is a sequence of decisions: a
 * fault (or none) at each effect point that may take one, and the next turn
 * at each scheduling decision of a concurrent run. One object makes them
 * all. Exploring from a seed draws them (`seededChooser`), replaying a
 * schedule looks them up (`replayChooser`), and exhaustive exploration picks
 * them from the enumerator (`exhaustive.ts`), which walks every sequence of
 * choices once. The run only asks; which faults a run may take, how many and
 * where is the chooser's, so the run loop holds no policy.
 */

import {
  compileFaultSites,
  decideFault,
  describePinnedFault,
  type FaultKind,
  type FaultPolicy,
  type JsonValue,
  nextInt,
  type PinnedSchedule,
  type Schedule,
  seedPrng,
} from "@eutaxy/core";

/** One option at a decision the run cannot make by itself. */
export interface ChoiceOption {
  /** Names the option the same way in every run that reaches it, e.g. "req-1#1@2", "start:0" or "crash_after". */
  readonly label: string;
  /** The invocation the option belongs to: the one a turn continues, or the one whose effect point a fault is at. */
  readonly invocation?: string;
  /** A turn: the target of the effect it performs. */
  readonly target?: string;
  /** A fault: the ordinal of the effect point within its invocation, which a recorded schedule keys on. */
  readonly ordinal?: number;
  /** A fault: the call at the effect point, which a pinned schedule's addresses match. */
  readonly call?: { readonly target: string; readonly op: string; readonly args: JsonValue };
}

/**
 * Makes a run's choices: which fault (or none) at an effect point, and which
 * turn next in a concurrent run.
 */
export interface Chooser {
  /** The seed of the run's virtual globals (time, randomness), and of every choice drawn rather than made. */
  readonly seed: number;
  /** Whether the turns it picks do not follow the seed, so the schedule must record them for replay. */
  readonly recordsTurns: boolean;
  /**
   * The index of the option taken. A fault decision offers "none" first,
   * then the faults the point allows, each option naming the point. A turn
   * decision offers the parked invocations in start order, then starting the
   * next event while a slot is free, then firing the earliest timer already
   * due when one may fire; it is put to the chooser even with one
   * option (an enumerated run can repeat an explored order there), and the
   * run records the pick only when there was more than one.
   */
  choose(kind: "fault" | "turn", options: readonly ChoiceOption[]): number;
}

/** Where a seeded run's faults go. */
export interface FaultPlacement extends FaultPolicy {
  /**
   * The eligible points (fault decisions, counted from 0) that take a fault,
   * kinds drawn from the seed (see `planFaults`). Absent: each eligible point
   * takes a fault with probability `faultProbability` (see `decideFault`).
   */
  readonly faultPlan?: readonly number[];
}

/**
 * Choices drawn from the seed: faults from a stream seeded by it, placed by
 * the plan; turns from a separate stream (`turns:<seed>`), so a fault more
 * or less does not move the picks after it.
 */
export function seededChooser(seed: number, placement: FaultPlacement): Chooser {
  let faults = seedPrng(seed);
  let turns = seedPrng(`turns:${seed}`);
  let position = 0;
  let injected = 0;
  return {
    seed,
    recordsTurns: false,
    choose(kind, options) {
      if (kind === "turn") {
        if (options.length < 2) return 0;
        const [i, next] = nextInt(turns, options.length);
        turns = next;
        return i;
      }
      if (options.length < 2) return 0;
      const at = position++;
      let i = 0;
      if (placement.faultPlan) {
        if (injected >= placement.maxFaultsPerRun || !placement.faultPlan.includes(at)) return 0;
        const [k, next] = nextInt(faults, options.length - 1);
        faults = next;
        i = k + 1;
      } else {
        // The options past "none" are the point's allowed faults, labelled by kind.
        const kinds = options.slice(1).map((o) => o.label as FaultKind);
        const [fault, next] = decideFault(faults, kinds, injected, placement);
        faults = next;
        i = fault === null ? 0 : kinds.indexOf(fault) + 1;
      }
      if (i > 0) injected++;
      return i;
    },
  };
}

/**
 * Choices a recorded schedule made: its fault at the point (none when it
 * recorded none, or one the point no longer allows), its turns when it
 * recorded them (the run takes one past the options as the first), else the
 * seed's.
 */
export function replayChooser(schedule: Schedule): Chooser {
  const recorded = schedule.turns;
  let replayed = 0;
  let turns = seedPrng(`turns:${schedule.seed}`);
  return {
    seed: schedule.seed,
    recordsTurns: recorded !== undefined,
    choose(kind, options) {
      if (kind === "turn") {
        if (options.length < 2) return 0;
        if (recorded) {
          return recorded[replayed++] ?? 0;
        }
        const [i, next] = nextInt(turns, options.length);
        turns = next;
        return i;
      }
      if (options.length < 2) return 0;
      const at = options[0];
      const decision = schedule.faults.find(
        (f) => f.invocation === at?.invocation && f.ordinal === at?.ordinal,
      );
      if (!decision) return 0;
      const i = options.findIndex((o) => o.label === decision.fault);
      return Math.max(i, 0);
    },
  };
}

/** A pinned schedule's chooser, which also says what of the schedule its run did not place. */
export interface PinnedChooser extends Chooser {
  /** Each pinned fault the run has not placed, and why; empty once every one is. */
  unplaced(): readonly string[];
}

/**
 * Choices a pinned schedule makes: each of its faults at the `call`-th
 * point of the run whose call its address matches (counting the points put
 * to the chooser, in the order the run reaches them), none elsewhere, and
 * turns from the seed as a seeded run draws them, so a pinned schedule is
 * replayed by its run's recorded schedule. When two of its faults want one
 * point, the first listed takes it.
 */
export function pinnedChooser(pinned: PinnedSchedule, seed: number): PinnedChooser {
  const matchers = pinned.faults.map((f) => compileFaultSites([f.at]));
  const counts = pinned.faults.map(() => 0);
  /** Per fault: "placed", why it could not be at its call, or null while its call has not come. */
  const outcomes: (string | null)[] = pinned.faults.map(() => null);
  let turns = seedPrng(`turns:${seed}`);
  return {
    seed,
    recordsTurns: false,
    choose(kind, options) {
      if (kind === "turn") {
        if (options.length < 2) return 0;
        const [i, next] = nextInt(turns, options.length);
        turns = next;
        return i;
      }
      const call = options[0]?.call;
      if (call === undefined || options.length < 2) return 0;
      const allowed = options.slice(1).map((o) => o.label as FaultKind);
      let taken = 0;
      pinned.faults.forEach((f, j) => {
        if (matchers[j]?.({ ...call, allowed }).length === 0) return;
        const n = (counts[j] ?? 0) + 1;
        counts[j] = n;
        if (n !== (f.call ?? 1)) return;
        const i = options.findIndex((o) => o.label === f.fault);
        if (i < 1) outcomes[j] = `met call ${n}, which allows only ${allowed.join(", ")}`;
        else if (taken > 0)
          outcomes[j] = `met call ${n}, which an earlier fault of the schedule took`;
        else {
          taken = i;
          outcomes[j] = "placed";
        }
      });
      return taken;
    },
    unplaced() {
      return pinned.faults.flatMap((f, j) => {
        const outcome = outcomes[j];
        if (outcome === "placed") return [];
        const why = outcome ?? `met no such call: the run made ${counts[j]} matching call(s)`;
        return [`fault ${j + 1} (${describePinnedFault(f)}) ${why}`];
      });
    },
  };
}

/**
 * The chooser under the run's fault bound: once it has taken `max` faults,
 * no further fault decision is put to it (the enumerator then sees no
 * choice there).
 */
export function limitFaults(chooser: Chooser, max: number): Chooser {
  let injected = 0;
  return {
    seed: chooser.seed,
    recordsTurns: chooser.recordsTurns,
    choose(kind, options) {
      if (kind !== "fault") return chooser.choose(kind, options);
      if (injected >= max) return 0;
      const i = chooser.choose(kind, options);
      if (i > 0) injected++;
      return i;
    },
  };
}
