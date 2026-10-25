/**
 * The concurrent scheduler. Each asynchronous effect of a concurrent run is
 * a turn: the invocation parks there, and once every invocation has parked,
 * finished or gone idle the run picks which parked one goes next (or whether
 * a new event starts): from the recorded turns when replaying them, from the
 * chooser when exploring exhaustively, else from a stream seeded by the
 * schedule's seed. It also tracks whether turns told apart by their parked
 * effects' targets may not commute, which partial-order reduction needs.
 */

import { nextInt, type PrngState, seedPrng } from "@eutaxy/core";
import { drainMicrotasks, realTick } from "./clock.ts";
import type { Frame, Frames } from "./frames.ts";
import type { ChoiceOption, RunOptions } from "./run.ts";

/** What the scheduler needs of an invocation. */
export interface Turner {
  readonly id: string;
  /** Times it has parked for a turn; names its next turn the same in every run. */
  parks: number;
  isCrashed(): boolean;
}

interface Parked {
  readonly inv: Turner;
  readonly seq: number;
  readonly go: () => void;
  /** For hosted code's effects: the hosting effect, waiting on this one meanwhile. */
  readonly host?: Frame;
  /** The turn as a choice: its label and the target of the effect it performs. */
  readonly option: ChoiceOption;
}

export class Turns {
  private readonly options: RunOptions;
  private readonly frames: Frames;
  /** Makes an invocation the running one. */
  private readonly runAs: (id: string | null) => void;
  /** The virtual globals' read counter, when they are installed. */
  private readonly reads: () => { count: number } | undefined;
  /** Invocations waiting at an effect for their turn. */
  private parked: Parked[] = [];
  private parkSeq = 0;
  /** The turns picked at decisions with more than one option, in order (see Schedule.turns). */
  private readonly picked: number[] = [];
  /** Turns taken from `schedule.turns` so far, when replaying recorded turns. */
  private replayed = 0;
  /** Events started so far, to name the next start the same in every run. */
  private starts = 0;
  /** The target of the turn running since the last decision; null for an event's start or none. */
  private turnTarget: string | null = null;
  private commuteNot = false;
  /** Woken whenever an invocation parks, a delivery ends or I/O completes. */
  private progressWaiters: (() => void)[] = [];
  /** The order invocations started in, which orders the parked ones. */
  private readonly startOrder = new Map<string, number>();
  /** The picks among parked invocations, drawn apart from fault decisions. */
  private prng: PrngState;

  constructor(
    options: RunOptions,
    frames: Frames,
    runAs: (id: string | null) => void,
    reads: () => { count: number } | undefined,
  ) {
    this.options = options;
    this.frames = frames;
    this.runAs = runAs;
    this.reads = reads;
    this.prng = seedPrng(`turns:${options.schedule.seed}`);
  }

  /** The turns picked so far, as a copy. */
  get picks(): readonly number[] {
    return [...this.picked];
  }

  /** An invocation started; its start orders its parked turns against others'. */
  started(id: string): void {
    this.startOrder.set(id, this.startOrder.size);
  }

  /** Park an invocation at an effect until `takeTurn` releases it with `go`. */
  park(inv: Turner, target: string, go: () => void, host?: Frame): void {
    const option = { label: `${inv.id}@${inv.parks++}`, invocation: inv.id, target };
    this.parked.push({ inv, seq: this.parkSeq++, go, option, ...(host ? { host } : {}) });
    this.progressed();
  }

  /** See `Run.turnsMayNotCommute`. */
  get mayNotCommute(): boolean {
    this.endSegment();
    return this.commuteNot;
  }

  /** See `Run.queuedEvents`. */
  queuedEvents(): void {
    if (this.turnTarget !== null) this.commuteNot = true;
  }

  /** An effect was performed: within a turn, one on another target is shared with other turns. */
  performed(target: string): void {
    if (this.turnTarget !== null && target !== this.turnTarget) this.commuteNot = true;
  }

  /** Close the code run since the last decision, noting whether a turn read the shared virtual state. */
  private endSegment(): void {
    const reads = this.reads();
    if (!reads) return;
    if (this.turnTarget !== null && reads.count > 0) this.commuteNot = true;
    reads.count = 0;
  }

  /** See `Run.progressed`. */
  progressed(): void {
    // While hosted code runs (a Durable Object call), a wake could come from inside it, and the
    // scheduler would resume in that object's I/O context, where workerd refuses other calls.
    // The scheduler's own zero timer wakes it then instead (see quiesce).
    if (this.frames.hostingNow > 0) return;
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const wake of waiters) wake();
  }

  /** See `Run.quiesce`. */
  async quiesce(): Promise<void> {
    for (;;) {
      await Promise.race([
        new Promise<void>((wake) => this.progressWaiters.push(wake)),
        realTick(),
      ]);
      await drainMicrotasks();
      if (this.frames.inFlight === 0) return;
    }
  }

  /** See `Run.takeTurn`. */
  takeTurn(canStart: boolean): "turn" | "start" | "none" {
    const order = (inv: Turner) => this.startOrder.get(inv.id) ?? 0;
    this.parked = this.parked
      .filter((p) => !p.inv.isCrashed())
      .sort((a, b) => order(a.inv) - order(b.inv) || a.seq - b.seq);
    const options = this.parked.length + (canStart ? 1 : 0);
    this.endSegment();
    this.turnTarget = null;
    if (options === 0) return "none";
    let pick = 0;
    if (options > 1) {
      pick = this.pickTurn(options, canStart);
      this.picked.push(pick);
    } else if (this.options.chooser && this.options.mode === "explore") {
      // Not a choice, but the enumerator sees it: a single turn can still repeat an explored order.
      this.options.chooser.choose("turn", this.turnOptions(canStart));
    }
    const [chosen] = pick < this.parked.length ? this.parked.splice(pick, 1) : [];
    if (!chosen) {
      this.starts++;
      return "start";
    }
    this.turnTarget = chosen.option.target ?? null;
    this.runAs(chosen.inv.id);
    const host = chosen.host;
    // Hosted code resumes: its host counts in flight again from now, before the code runs.
    if (host) this.frames.adjust(host, () => host.waitingChildren--);
    chosen.go();
    return "turn";
  }

  /** The turns on offer, as choices: the parked invocations in order, then starting the next event. */
  private turnOptions(canStart: boolean): ChoiceOption[] {
    return [
      ...this.parked.map((p) => p.option),
      ...(canStart ? [{ label: `start:${this.starts}` }] : []),
    ];
  }

  /** The turn at a decision with more than one option: recorded, chosen, or drawn from the seed. */
  private pickTurn(options: number, canStart: boolean): number {
    const recorded = this.options.schedule.turns;
    if (this.options.mode === "replay" && recorded) {
      const i = recorded[this.replayed++] ?? 0;
      return i < options ? i : 0;
    }
    const chooser = this.options.chooser;
    if (chooser && this.options.mode === "explore")
      return chooser.choose("turn", this.turnOptions(canStart));
    const [i, next] = nextInt(this.prng, options);
    this.prng = next;
    return i;
  }
}
