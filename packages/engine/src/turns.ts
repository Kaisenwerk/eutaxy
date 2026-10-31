/**
 * The concurrent scheduler. Each asynchronous effect of a concurrent run is
 * a turn: the invocation parks there, and once every invocation has parked,
 * finished or gone idle the run's chooser picks which parked one goes next
 * (or whether a new event starts). It also tracks whether turns told apart
 * by their parked effects' targets may not commute, which partial-order
 * reduction needs.
 *
 * Between turns the run waits for the code it released to come to rest
 * (`quiesce`): progress (a park, a delivery's end, real I/O completing)
 * wakes it, and before it decides every continuation that progress set off
 * has run, which takes one turn of the host's event loop: `setImmediate`
 * where that is cheap (Node), else the real zero timer the wait armed, which
 * also polls for the moves of hosted code, which cannot wake it, and gives
 * code waiting on something it cannot see its allowance. One such turn per
 * decision is the floor in workerd, where a zero timer is the only way to
 * the event loop and costs about a millisecond.
 */

import type { ChoiceOption, Chooser } from "./chooser.ts";
import { cheapEventLoopTurn, realDeadline } from "./clock.ts";
import type { Frame, Frames } from "./frames.ts";

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
  private readonly chooser: Chooser;
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
  /** Events started so far, to name the next start the same in every run. */
  private starts = 0;
  /** The target of the turn running since the last decision; null for an event's start or none. */
  private turnTarget: string | null = null;
  private commuteNot = false;
  /** Woken whenever an invocation parks, a delivery ends or I/O completes (see `progressed`). */
  private progressWaiters: (() => void)[] = [];
  /** Times something moved, hosted code's moves included, and the count the last wait or step saw. */
  private moves = 0;
  private seenMoves = 0;
  /** Parks and delivery ends so far, and the count when the current step began. */
  private rests = 0;
  private restsAtStep = 0;
  /** The order invocations started in, which orders the parked ones. */
  private readonly startOrder = new Map<string, number>();

  constructor(
    chooser: Chooser,
    frames: Frames,
    runAs: (id: string | null) => void,
    reads: () => { count: number } | undefined,
  ) {
    this.chooser = chooser;
    this.frames = frames;
    this.runAs = runAs;
    this.reads = reads;
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
    this.rested();
  }

  /** See `Run.rested`. */
  rested(): void {
    this.rests++;
    this.progressed();
  }

  /**
   * A step begins: a turn is released, an event starts or a timer fires.
   * `quiesce` then waits for what the step set off to come to rest. Called
   * by `takeTurn` and, for timers, by the run.
   */
  step(): void {
    this.restsAtStep = this.rests;
    this.seenMoves = this.moves;
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
    this.moves++;
    // While hosted code runs (a Durable Object call), a wake could come from inside it, and the
    // scheduler would resume in that object's I/O context, where workerd refuses other calls
    // ("Cannot perform I/O on behalf of a different Durable Object"). The scheduler's own zero
    // timer polls for the move then instead (see quiesce).
    if (this.frames.hostingNow > 0) return;
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const wake of waiters) wake();
  }

  /** See `Run.quiesce`. */
  async quiesce(): Promise<void> {
    for (;;) {
      const moved = await this.wait();
      // Real I/O: its completion wakes the next wait, and hosted code's moves show at its end.
      if (this.frames.inFlight > 0) continue;
      // An invocation parked or a delivery ended since the step: what the step set off is at rest.
      if (this.rests !== this.restsAtStep) return;
      // Nothing in flight and nothing at rest: code waiting on something Eutaxy cannot see has one
      // turn of the event loop, as the sequential path gives, before it counts as idle; a wait
      // that saw nothing move was that turn.
      if (!moved) return;
    }
  }

  /**
   * Wait for a move (see `progressed`) or one real zero timer, whichever
   * comes first (no wait when something moved since the last one), then
   * let everything the move set off run before the caller looks: one turn
   * of the event loop, the cheap one where the host has it, else the timer
   * armed for the wait, after which the microtask queue is empty too.
   * Returns whether anything moved since the last wait.
   */
  private async wait(): Promise<boolean> {
    const before = this.seenMoves;
    const racing = this.moves === before;
    const tick = racing || !cheapEventLoopTurn ? realDeadline(0) : undefined;
    if (racing && tick) {
      let wake: () => void = () => {};
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.progressWaiters.push(wake);
      await Promise.race([woken, tick.expired]);
      const i = this.progressWaiters.indexOf(wake);
      if (i >= 0) this.progressWaiters.splice(i, 1);
    }
    if (cheapEventLoopTurn) {
      tick?.cancel();
      await cheapEventLoopTurn();
    } else await tick?.expired;
    this.seenMoves = this.moves;
    return this.moves !== before;
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
    this.step();
    if (options === 0) return "none";
    // Put to the chooser even with one option (the enumerator sees it: a single turn can still
    // repeat an explored order); recorded only when it was a choice. An answer past the options
    // (a recorded turn from a run that had more) means the first.
    const answer = this.chooser.choose("turn", this.turnOptions(canStart));
    const pick = answer < options ? answer : 0;
    if (options > 1) this.picked.push(pick);
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
}
