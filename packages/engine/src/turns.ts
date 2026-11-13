/**
 * The concurrent scheduler. Each asynchronous effect of a concurrent run is
 * a turn: the invocation parks there, and once every invocation has parked,
 * finished or gone idle the run's chooser picks which parked one goes next,
 * whether a new event starts, or whether a virtual timer already due fires
 * (ready work like a parked effect; timers not yet due fire only when
 * nothing else can move). It also tracks whether turns told apart by their
 * parked effects' targets may not commute, which partial-order reduction
 * needs.
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

/** A virtual timer already due that may fire now, offered as a turn (see `Run.takeTurn`). */
export interface DueTimer {
  /** The invocation that set it, which its callback runs as. */
  readonly owner: string | null;
  /** Timers of that owner fired so far: names the turn the same in every run. */
  readonly fired: number;
  /** Fire it: the earliest due timer the run allows, as its owner. */
  readonly fire: () => void;
}

interface Parked {
  readonly inv: Turner;
  readonly seq: number;
  readonly go: () => void;
  /** For hosted code's effects: the hosting effect, waiting on this one meanwhile. */
  readonly host?: Frame;
  /**
   * The attempt whose code parked here, if any, read live: a late attempt's
   * turn is offered like any other, but holds nothing (see `takeTurn`).
   */
  readonly attempt: { readonly late: boolean } | undefined;
  /** Whether the code that parked here is gone (an object's instance that was reset): its turn is nobody's. */
  readonly gone?: () => boolean;
  /** The turn as a choice: its label and the target of the effect it performs. */
  readonly option: ChoiceOption;
}

/**
 * How often one run may let time pass over late turns before they must run:
 * a stray interval would otherwise be fired forever while late code waits.
 */
export const waitLimit = 100;

export class Turns {
  private readonly chooser: Chooser;
  private readonly frames: Frames;
  /** Makes an invocation the running one. */
  private readonly runAs: (id: string | null) => void;
  /** The virtual globals' read counter, when they are installed. */
  private readonly reads: () => { count: number } | undefined;
  /** Work on its way that no frame counts: a host's timer fired and not yet run by its poller. */
  private readonly pending: () => number;
  /** Whether an object's work after an answer may be running: a wake could then come from inside it. */
  private readonly inObjects: () => boolean;
  /** Whether everything in flight is a hosting effect whose code is idle (see `Frames.idleHosts`). */
  private readonly idleHosted: () => boolean;
  /** Invocations waiting at an effect for their turn. */
  private parked: Parked[] = [];
  private parkSeq = 0;
  /** The turns picked at decisions with more than one option, in order (see Schedule.turns). */
  private readonly picked: number[] = [];
  /** Events started so far, to name the next start the same in every run. */
  private starts = 0;
  /** Times the run let time pass over late turns (see `takeTurn`). */
  private waits = 0;
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
    pending: () => number = () => 0,
    inObjects: () => boolean = () => false,
    idleHosted: () => boolean = () => false,
  ) {
    this.chooser = chooser;
    this.frames = frames;
    this.runAs = runAs;
    this.reads = reads;
    this.pending = pending;
    this.inObjects = inObjects;
    this.idleHosted = idleHosted;
  }

  /** The turns picked so far, as a copy. */
  get picks(): readonly number[] {
    return [...this.picked];
  }

  /** An invocation started; its start orders its parked turns against others'. */
  started(id: string): void {
    this.startOrder.set(id, this.startOrder.size);
  }

  /**
   * Whether a turn is parked that belongs to one of these hosts: an effect
   * made by code a call into the host hosts, or by the host's work after an
   * answer (its continuation, `<host>/after`).
   */
  parkedFor(hosts: ReadonlySet<string>): boolean {
    return this.parked.some((p) => {
      if (p.host?.host !== undefined && hosts.has(p.host.host)) return true;
      // `<host>/after`, or `<host>/after#<n>` for a later instance's: the id's end, since a host's
      // own name may hold "/after" too.
      const continuation = /^(.*)\/after(?:#\d+)?$/.exec(p.inv.id);
      return continuation !== null && hosts.has(continuation[1] as string);
    });
  }

  /** Park an invocation at an effect until `takeTurn` releases it with `go`. */
  park(
    inv: Turner,
    target: string,
    go: () => void,
    host?: Frame,
    attempt?: { readonly late: boolean },
    gone?: () => boolean,
  ): void {
    const option = { label: `${inv.id}@${inv.parks++}`, invocation: inv.id, target };
    this.parked.push({
      inv,
      seq: this.parkSeq++,
      go,
      option,
      attempt,
      ...(host ? { host } : {}),
      ...(gone ? { gone } : {}),
    });
    this.rested();
  }

  /**
   * The hosting effect `host` ended with effects of its hosted code parked:
   * they are `owner`'s turns now (the host's work after its answer), so the
   * caller's crash does not drop them and a fault in them is the owner's.
   */
  adopt(host: Frame, owner: Turner): void {
    this.parked = this.parked.map((p) =>
      p.host === host ? { ...p, inv: owner, option: { ...p.option, invocation: owner.id } } : p,
    );
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
    // While hosted code runs (a Durable Object call, or an object's work after its answer), a wake
    // could come from inside it (a park, an event queued), and the scheduler would resume in that
    // object's I/O context, where workerd refuses other calls ("Cannot perform I/O on behalf of a
    // different Durable Object") and counts what it then does against the object. The scheduler's
    // own zero timer polls for the move then instead (see quiesce).
    if (this.frames.hostingNow > 0 || this.inObjects()) return;
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const wake of waiters) wake();
  }

  /** See `Run.quiesce`. */
  async quiesce(): Promise<void> {
    for (;;) {
      const moved = await this.wait();
      // A host's timer fired and not yet run is on its way.
      if (this.pending() > 0) continue;
      // Real I/O: its completion wakes the next wait, and hosted code's moves show at its end. When
      // only hosting effects whose code is idle are in flight and a wait saw nothing move, that
      // code awaits a timer of its own (an object sleeping before it answers): at rest, for the
      // run to fire it.
      if (this.frames.inFlight > 0) {
        if (!moved && this.idleHosted()) return;
        continue;
      }
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

  /**
   * See `Run.takeTurn`. `canWait`: whether, with nothing else to do, the run
   * could let time pass (a timer is pending or a delayed event is due later).
   * While every parked turn is late (`RunHooks.attempt`) and nothing else is
   * on offer, waiting is an option too, so the late code's next move lands
   * before or after what the time brings; "none" then means the run should
   * let time pass as when nothing is parked.
   */
  takeTurn(
    canStart: boolean,
    timer?: DueTimer,
    canWait = false,
  ): "turn" | "start" | "timer" | "none" {
    const order = (inv: Turner) => this.startOrder.get(inv.id) ?? 0;
    this.parked = this.parked
      .filter((p) => !p.inv.isCrashed() && !p.gone?.())
      .sort((a, b) => order(a.inv) - order(b.inv) || a.seq - b.seq);
    const waiting =
      canWait &&
      !canStart &&
      !timer &&
      this.waits < waitLimit &&
      this.parked.length > 0 &&
      this.parked.every((p) => p.attempt?.late === true);
    const offered = this.turnOptions(canStart, timer, waiting);
    const options = offered.length;
    this.endSegment();
    this.turnTarget = null;
    this.step();
    if (options === 0) return "none";
    // Put to the chooser even with one option (the enumerator sees it: a single turn can still
    // repeat an explored order); recorded only when it was a choice. An answer past the options
    // (a recorded turn from a run that had more) means the first.
    const answer = this.chooser.choose("turn", offered);
    const pick = answer < options ? answer : 0;
    if (options > 1) this.picked.push(pick);
    const [chosen] = pick < this.parked.length ? this.parked.splice(pick, 1) : [];
    if (!chosen) {
      // Past the parked turns, which were all late: time passes over them.
      if (waiting) {
        this.waits++;
        return "none";
      }
      // Past the parked turns: the due timer is the last option when there is one, else the start.
      if (timer && pick === options - 1) {
        // Like a start, a timer turn is ordered against every other (its option has no target), so
        // what its callback does is not a turn's own effect: turnTarget stays null.
        timer.fire();
        return "timer";
      }
      this.starts++;
      return "start";
    }
    this.turnTarget = chosen.option.target ?? null;
    this.runAs(chosen.inv.id);
    const host = chosen.host;
    // Hosted code resumes: its turn is on its way to it, so its host counts in flight from now,
    // before the code runs, until the effect performs (`Run.hostedTurn`).
    if (host) this.frames.adjust(host, () => host.arriving++);
    chosen.go();
    return "turn";
  }

  /**
   * The turns on offer, as choices: the parked invocations in order, then
   * starting the next event, then the due timer (last, so a recorded pick
   * of the others means the same with or without it), or, when every parked
   * turn is late and nothing else is offered, letting time pass. A timer's
   * option names its owner and how many of that owner's timers have fired,
   * and has no target: the callback may do anything, and firing it reads
   * virtual time, so it commutes with nothing; so does waiting, which fires
   * the next timer.
   */
  private turnOptions(canStart: boolean, timer?: DueTimer, waiting = false): ChoiceOption[] {
    return [
      ...this.parked.map((p) => p.option),
      ...(canStart ? [{ label: `start:${this.starts}` }] : []),
      ...(timer
        ? [
            {
              label: `timer:${timer.owner ?? ""}@${timer.fired}`,
              ...(timer.owner !== null ? { invocation: timer.owner } : {}),
            },
          ]
        : []),
      ...(waiting ? [{ label: `wait:${this.waits}` }] : []),
    ];
  }
}
