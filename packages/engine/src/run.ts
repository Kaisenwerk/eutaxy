/**
 * One run of a scenario: the effect log being built, the fault decisions
 * (made by the run's chooser, see `chooser.ts`), and the invocations in
 * flight. Proxies in the platform package call `effect`/`effectSync`
 * around every real effect; everything else is engine-internal.
 *
 * With `maxConcurrentInvocations` above 1 the run is concurrent: several
 * invocations are in flight and each asynchronous effect is a turn, which
 * `turns.ts` schedules; `frames.ts` tracks effects nested in others and what
 * is in flight. Each delivery runs in its own async context, so an effect is
 * attributed to the invocation whose code made it even when a promise shared
 * between invocations resumes one during another's turn.
 */

import {
  type Attempt,
  type Bounds,
  decisionTarget,
  type EffectLog,
  type EffectOptions,
  type EffectPoint,
  type EffectRecord,
  type EventRef,
  type ExternalDecl,
  type FaultDecision,
  type FaultKind,
  type Invocation,
  type JsonValue,
  type RunHooks,
  type Schedule,
} from "@eutaxy/core";
import type { Chooser } from "./chooser.ts";
import {
  effectLatencyMs,
  eventLoopTurn,
  type Patched,
  patchGlobals,
  realDeadline,
  realTick,
  settleOn,
} from "./clock.ts";
import { asyncScope } from "./context.ts";
import { installScriptedFetch } from "./fetch.ts";
import { effectScope, Frame, Frames } from "./frames.ts";

/** The host's own timer, captured before any patching: a host poller's ticks are real. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

import { type DueTimer, Turns } from "./turns.ts";

/** Thrown into user code by a synchronous effect that crashes the invocation. */
export class CrashSignal extends Error {
  override readonly name = "CrashSignal";
  readonly invocation: string;
  constructor(invocation: string) {
    super(`invocation ${invocation} crashed by an injected fault`);
    this.invocation = invocation;
  }
}

/** The error user code sees for an injected `error` or `ambiguous` fault. */
export class InjectedEffectError extends Error {
  override readonly name = "InjectedEffectError";
  readonly point: EffectPoint;
  readonly fault: FaultKind;
  constructor(point: EffectPoint, fault: FaultKind) {
    super(`${point.target} ${point.op} failed (injected ${fault})`);
    this.point = point;
    this.fault = fault;
  }
}

export interface RunOptions {
  readonly bounds: Bounds;
  /**
   * Makes the run's choices, faults and turns alike, and gives the seed of
   * its virtual globals. The run applies no fault policy of its own: how many
   * faults a run takes is the chooser's (`seededChooser` places them, a
   * replayed schedule has them, `limitFaults` bounds any other), so a
   * chooser built by hand is unbounded unless wrapped.
   */
  readonly chooser: Chooser;
}

class InvocationState implements Invocation {
  readonly crashed: Promise<void>;
  private readonly onCrash: (inside?: Frame) => void;
  /** Effect points seen so far in this invocation; the next effect's ordinal. */
  ordinal = 0;
  /** Times this invocation has parked for a turn; names its next turn the same in every run. */
  parks = 0;
  private crashedFlag = false;
  private resolveCrashed: () => void = () => {};
  readonly id: string;

  constructor(id: string, onCrash: (inside?: Frame) => void) {
    this.id = id;
    this.onCrash = onCrash;
    this.crashed = new Promise<void>((resolve) => {
      this.resolveCrashed = resolve;
    });
  }

  isCrashed(): boolean {
    return this.crashedFlag;
  }

  /** `inside`: the effect the crash happened inside of, when one did (a nested effect's fault). */
  crash(inside?: Frame): void {
    if (this.crashedFlag) return;
    this.crashedFlag = true;
    this.onCrash(inside);
    this.resolveCrashed();
  }
}

/** The invocation a delivery started, set when it starts it; carried by the delivery's async context. */
interface DeliveryCell {
  id: string | null;
}

const deliveryScope = asyncScope<DeliveryCell>();

/**
 * The host (`EffectOptions.host`) whose code is running, set by `hostedCode`:
 * an object's, which the runtime enters without async context, and the
 * effect of the host's whose call that code is, when it is known.
 */
interface HostContext {
  readonly host: string;
  readonly frame: Frame | undefined;
  /** Which instance of the host the code belongs to: how many times the host had been reset when it entered. */
  readonly instance: number;
}

/** An instance of a host: the host, and how many times it had been reset when the instance began. */
interface Instance {
  readonly host: string;
  readonly instance: number;
}
const hostScope = asyncScope<HostContext | undefined>();

/** The attempt (`RunHooks.attempt`) whose code is running, and whether the platform has given up on it. */
interface AttemptCell {
  late: boolean;
}
const attemptScope = asyncScope<AttemptCell>();

/** The run whose globals are installed, if any: where code observed from outside records into. */
let installed: Run | null = null;

export function installedRun(): Run | null {
  return installed;
}

/** Whether this host can run concurrent invocations: attribution needs async context. */
export const concurrencySupported = deliveryScope !== null;

/** A delivery started by a concurrent run. */
export interface StartedDelivery<T> {
  readonly promise: Promise<T>;
  /** The invocation it started; null until it starts one. */
  invocation(): string | null;
}

/** A promise that never settles: how an abandoned invocation experiences a crash. */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Why an invocation that nothing can move is abandoned. */
function waitingUnseen(invocation: string): string {
  return `invocation ${invocation} is waiting on something Eutaxy cannot see (no effect in flight, no timer due)`;
}

/**
 * Timers an object's work may fire without the work settling before the run
 * is called UNSUPPORTED: a heartbeat (`setInterval`, a timeout that re-arms
 * itself) never settles, and the runtime would run it until the object is
 * evicted, which a run cannot wait for. The count starts over each time the
 * work settles, so an object that sleeps once per call is not a heartbeat.
 */
export const afterWorkTimerLimit = 100;

/** Delivered invocations are `<event>#<attempt>`, so this id is never one of theirs. */
const bookkeepingId = "platform";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class Run implements RunHooks {
  /** The records, appended in place. */
  private readonly entries: EffectRecord[] = [];
  /**
   * The log last handed out, a snapshot of the records then: what a run returned never changes
   * under its reader, however late an abandoned effect's I/O records its result. Rebuilt on the
   * next read after a record, so a run reads it once at its end and a differential once per event.
   */
  private logView: EffectLog | null = null;
  private readonly faults: FaultDecision[] = [];
  private effectIndex = 0;
  private eligibleSeen = 0;
  private readonly invocations = new Map<string, InvocationState>();
  private readonly reasons: string[] = [];
  private readonly frames = new Frames();
  /**
   * Invocations whose code runs inside an effect of another's (a called
   * Worker's code inside the call's effect), with the frame hosting each; see
   * `hosted`.
   */
  private readonly hosts = new Map<string, Frame>();
  /** Per host (`EffectOptions.host`), the invocation its work after an answer runs as; see `continuationOf`. */
  private readonly continuations = new Map<string, InvocationState>();
  /** Per host, how many such invocations it has had: one more after each reset of the object. */
  private readonly continuationCounts = new Map<string, number>();
  /** Per host, the last of its effects performed: its `onAbandon` resets the object when its later work crashes. */
  private readonly hostFrames = new Map<string, Frame>();
  /** Continuations with work that may still move: the run does not end while one is alive. */
  private readonly afterWork = new Set<InvocationState>();
  /** Per continuation, timers of its fired since its work last settled (see `afterWorkTimerLimit`). */
  private readonly afterWorkTimers = new Map<string, number>();
  /** Per owner, timers fired so far (any path): names a timer turn (see `dueTimer`). */
  private readonly timersFired = new Map<string | null, number>();
  /** Per host, real work its code started and the run tracks (Web Crypto) still running; see `leftHost`. */
  private readonly hostIo = new Map<string, number>();
  /**
   * Hosting effects that ended with effects of their hosted code outstanding
   * (parked or performing), and the host's work after its answer, which owns
   * those effects from then on; see `ownerOf`.
   */
  private readonly adopted = new WeakMap<Frame, InvocationState>();
  /** Per hosted invocation, the object (host) whose code it was hosted from, directly or through another: see `hosted`. */
  private readonly hostedWithin = new Map<string, Instance>();
  /**
   * Per host, how many times it was reset. Code belongs to the instance it
   * entered (`HostContext.instance`); once the host is reset that instance
   * is gone, and with it everything that ran in its context: its code makes
   * no further effect and takes no turn, a Worker it called dies with it,
   * what it awaited ends or goes on as another object's own work, and the
   * calls that were inside it will not be answered (`hostAbandoned`).
   */
  private readonly resetCounts = new Map<string, number>();
  /**
   * Calls whose caller was reset while the called object's code was running
   * (`Frame.orphaned`), each with the deadline the run timed it under once
   * one of its loops came by (`watchOrphans`).
   */
  private readonly orphans = new Map<Frame, { cancel(): void } | null>();
  /**
   * Per host, its poller (concurrent runs; see `pollHost`): the waits its
   * ticks wake, and the turns released to the host's code since its last
   * tick (`releasedTo`).
   */
  private readonly hostPollers = new Map<string, { waiters: (() => void)[]; unseen: number }>();
  /** Concurrent runs: settles waiting on invocations, released with a `CrashSignal` once theirs crashed; see `settle`. */
  private crashWatch: { readonly inv: InvocationState; readonly reject: (err: unknown) => void }[] =
    [];
  private patched: Patched | null = null;
  private restoreFetch: (() => void) | null = null;
  /** The invocation whose code is running (one at a time); outbound fetches are attributed to it. */
  private current = "";
  /** Events a platform queued during a delivery, for the run loop to pick up. */
  private queued: EventRef[] = [];
  /** Concurrent runs only: the scheduler of turns. */
  private readonly turns: Turns;

  /** Whether several invocations may be in flight (`maxConcurrentInvocations` above 1). */
  readonly concurrent: boolean;

  private readonly options: RunOptions;

  constructor(options: RunOptions) {
    this.options = options;
    this.turns = new Turns(
      options.chooser,
      this.frames,
      (id) => this.runAs(id),
      () => this.patched?.reads,
      () => this.firedPending() + this.releasedUnseen(),
      () => this.hasAfterWork(),
      () => this.timersAllowed() !== null || this.idleBehindParked(),
    );
    this.concurrent = options.bounds.maxConcurrentInvocations > 1;
  }

  get log(): EffectLog {
    this.logView ??= { entries: [...this.entries] };
    return this.logView;
  }

  /** The schedule as actually executed: the faults taken and, when they do not follow the seed, the turns. */
  get schedule(): Schedule {
    const { seed, recordsTurns } = this.options.chooser;
    return {
      seed,
      faults: [...this.faults],
      ...(recordsTurns ? { turns: [...this.turns.picks] } : {}),
    };
  }

  get effectPoints(): number {
    return this.effectIndex;
  }

  get faultsInjected(): number {
    return this.faults.length;
  }

  /**
   * Whether a turn other than an event's start did more than its own effect:
   * performed an effect on another target (synchronous, or nested in it),
   * queued events, or read virtual time or randomness (effects advance the clock and draws the
   * stream). Turns told apart by their parked effects' targets need not
   * commute then. A start is ordered against every turn anyway, so what it
   * does does not count.
   */
  get turnsMayNotCommute(): boolean {
    return this.turns.mayNotCommute;
  }

  /**
   * Concurrent runs: events were queued since the last decision (follow-ups
   * of a delivery that ended, or `enqueue`). The queue's order is shared, so
   * within a turn this is another dependence.
   */
  queuedEvents(): void {
    this.turns.queuedEvents();
  }

  get unsupportedReasons(): readonly string[] {
    return this.reasons;
  }

  /** Replace the nondeterministic globals and `fetch` for this run. Call `uninstall` in a finally. */
  install(externals: readonly ExternalDecl[] = []): void {
    installed = this;
    if (!this.patched) {
      this.patched = patchGlobals(this.options.chooser.seed, {
        // Web Crypto is real work the handler waits on: the run waits for it like an effect's I/O.
        // A host's code's is the host's: work of its own still pending once its effect has ended.
        trackIo: (work) => {
          this.frames.inFlight++;
          const host = hostScope?.getStore()?.host;
          if (host !== undefined) this.hostIo.set(host, (this.hostIo.get(host) ?? 0) + 1);
          return work.finally(() => {
            this.frames.inFlight--;
            if (host !== undefined) {
              const left = (this.hostIo.get(host) ?? 1) - 1;
              if (left > 0) this.hostIo.set(host, left);
              else this.hostIo.delete(host);
            }
            if (this.concurrent) this.progressed();
          });
        },
      });
      // Timers belong to the invocation running when they are set, hosted code's included (its
      // context is a cell of its own in either mode); in a sequential run that is `current` otherwise.
      const clock = this.patched.clock;
      clock.ownerNow = () => this.timerOwner();
      // Whose code set a timer: a host's timers are the host's, pending work of its own once its effect ends.
      clock.scopeNow = () => hostScope?.getStore()?.host;
      // Whichever path fires a timer of an object's work counts it against the heartbeat bound.
      clock.afterFire = (owner) => {
        this.timersFired.set(owner, (this.timersFired.get(owner) ?? 0) + 1);
        if (owner !== null) this.timerFired(owner);
      };
      // A timer's callback, and everything it goes on to run, belongs to the invocation that set it:
      // its delivery's or hosted cell where it has one, else a cell naming the invocation running now,
      // so a sequential caller's timer fired while a hosted callee waits is still the caller's.
      clock.bind = (callback) => {
        if (!deliveryScope) return callback;
        const scope = deliveryScope;
        const cell = scope.getStore() ?? { id: this.running() };
        // A host's code's timer runs as the host's code too (the runtime does that where it runs it).
        const inHostCtx = hostScope?.getStore();
        const inHost = (fn: () => void): void => {
          if (hostScope && inHostCtx !== undefined) hostScope.run(inHostCtx, fn);
          else fn();
        };
        // An attempt's timer callback is the attempt's code still (`RunHooks.attempt`).
        const inAttemptCell = attemptScope?.getStore();
        const inAttempt = (fn: () => void): void => {
          if (attemptScope && inAttemptCell !== undefined) attemptScope.run(inAttemptCell, fn);
          else fn();
        };
        return (...args) => scope.run(cell, () => inHost(() => inAttempt(() => callback(...args))));
      };
    }
    if (!this.restoreFetch) {
      this.restoreFetch = installScriptedFetch(
        externals,
        { hooks: this, invocation: () => this.running() },
        (reason) => this.unsupported(reason),
      );
    }
  }

  uninstall(): void {
    if (installed === this) installed = null;
    // The run is over: nothing of it is timed any longer.
    for (const deadline of this.orphans.values()) deadline?.cancel();
    this.orphans.clear();
    this.restoreFetch?.();
    this.restoreFetch = null;
    this.patched?.restore();
    this.patched = null;
  }

  /** Virtual milliseconds since the epoch, or the real clock when the globals are not installed. */
  now(): number {
    return this.patched ? this.patched.clock.now() : Date.now();
  }

  startInvocation(id: string, options: { readonly bookkeeping?: boolean } = {}): Invocation {
    const inv = this.track(id);
    if (options.bookkeeping) return inv;
    if (this.concurrent) {
      this.turns.started(id);
      // Only a delivery's first invocation is its own; a platform's bookkeeping invocation,
      // started during another's turn or after every delivery, takes nothing over.
      const cell = deliveryScope?.getStore();
      if (cell && cell.id === null) {
        cell.id = id;
        this.runAs(id);
      }
      return inv;
    }
    this.runAs(id);
    return inv;
  }

  enqueue(event: EventRef): void {
    this.queued.push(event);
    if (this.concurrent) this.progressed();
  }

  /** Events platforms queued with `enqueue` since the last call. */
  takeQueued(): EventRef[] {
    const queued = this.queued;
    this.queued = [];
    return queued;
  }

  running(): string {
    // A host's code running while none of its effects is performed: its work after an answer, its continuation's.
    const host = this.afterWorkHost();
    if (host !== undefined) return this.continuationOf(host).id;
    // A delivery's cell in a concurrent run, a hosted invocation's cell in either; else the one run as.
    return deliveryScope?.getStore()?.id ?? this.current;
  }

  hostEntering<T>(host: string, code: () => T): T {
    // Already the host's code (a method of its holding the gate): nothing to add.
    if (hostScope?.getStore()?.host === host) return code();
    if (this.concurrent) this.pollHost(host);
    const frame = this.frames.enteringHost(host);
    // The host's code, as in `hostedCode`: its timers are virtual and the host's.
    const run = (): T => (this.patched ? this.patched.handlerCode(code) : code());
    const instance = this.instanceOf(host);
    if (!frame) return hostScope ? hostScope.run({ host, frame, instance }, run) : run();
    // While it runs the entering call is code that may be awaiting a timer of its own, or an
    // effect of its own that is parked.
    this.frames.adjust(frame, () => {
      frame.entering++;
    });
    const left = (): void =>
      this.frames.adjust(frame, () => {
        frame.entering--;
      });
    let result: T;
    try {
      result = hostScope ? hostScope.run({ host, frame, instance }, run) : run();
    } catch (err) {
      left();
      throw err;
    }
    if (isThenable(result)) void Promise.resolve(result).then(left, left);
    else left();
    return result;
  }

  hostedCode<T>(host: string, code: () => T, op?: string): T {
    // The host's code entering again (a method calling another of the object's): the same call.
    if (hostScope?.getStore()?.host === host) return code();
    if (this.concurrent) this.pollHost(host);
    // The call this code is: the host's effect being performed around it (an alarm, a WebSocket
    // message, run by the platform inside the effect), else the oldest of the host's effects with
    // this op whose call has not started (a stub call: the object's input gate delivers them in
    // arrival order).
    const current = this.frames.current();
    const frame =
      current?.host === host && current.active ? current : this.frames.claimHost(host, op);
    // The call has crossed into the object: its code runs from here (and may now count as waiting).
    if (frame)
      this.frames.adjust(frame, () => {
        frame.entered = true;
      });
    // An object's code is handler code: its timers are virtual, inside a call's I/O or not.
    const run = (): T => (this.patched ? this.patched.handlerCode(code) : code());
    const instance = this.instanceOf(host);
    const result = hostScope ? hostScope.run({ host, frame, instance }, run) : run();
    // Once the code has returned its answer is in transit: the call is no longer idle code that a
    // timer of the host's may wake (a timer it set and did not await fires after the answer), and
    // it is in flight until the answer has crossed, whatever the code left parked.
    if (frame) {
      const answered = (): void => {
        this.frames.answered(frame);
        // Its caller was reset meanwhile: nobody is left to take the answer and end the call.
        if (frame.orphaned) frame.end();
      };
      if (isThenable(result)) void Promise.resolve(result).then(answered, answered);
      else answered();
    }
    return result;
  }

  /**
   * Concurrent runs: the host's poller, a real zero timer armed here, inside
   * the host's code during its request, and re-armed from its own ticks while
   * the host may still move (an effect of its being performed, work of its
   * own alive, a wait pending). Each tick wakes the host's waits (`hostTick`):
   * the host's work after an answer waits for its turns on them, since a
   * timer that work armed itself, after its request completed, would keep the
   * object referenced in workerd.
   */
  private pollHost(host: string): void {
    if (this.hostPollers.has(host)) return;
    const poller = { waiters: [] as (() => void)[], unseen: 0 };
    this.hostPollers.set(host, poller);
    const tick = (): void => {
      const waiters = poller.waiters;
      poller.waiters = [];
      const released = poller.unseen;
      for (const wake of waiters) wake();
      // The code a wake resumes sees its release within this tick; code a reset tore down never will.
      if (released > 0)
        void Promise.resolve().then(() => {
          poller.unseen -= released;
        });
      if (poller.waiters.length > 0 || this.hostMayMove(host)) realSetTimeout(tick, 0);
      else this.hostPollers.delete(host);
    };
    realSetTimeout(tick, 0);
  }

  /**
   * A turn was released to code that waits for it by polling from inside
   * `host` (an object's effect during a call, or in its work after an
   * answer). Until the host's poller ticks, the effect is neither parked
   * nor in flight, and the scheduler must not take the run for at rest: it
   * would decide with that code's next effect missing from its options on
   * a slow tick and present on a fast one. Counted against the poller, so
   * a host that was reset, whose poller is gone, is not waited for.
   */
  private releasedTo(host: string | undefined): void {
    const poller = host === undefined ? undefined : this.hostPollers.get(host);
    if (poller) poller.unseen++;
  }

  /** Turns released to hosts' code and not yet seen by it (see `releasedTo`): work on its way. */
  private releasedUnseen(): number {
    let n = 0;
    for (const poller of this.hostPollers.values()) n += poller.unseen;
    return n;
  }

  private hostMayMove(host: string): boolean {
    const cont = this.continuations.get(host);
    const alive = cont !== undefined && !cont.isCrashed() && this.afterWork.has(cont);
    return alive || this.frames.liveHost(host) !== undefined;
  }

  /** One tick of the host's poller, from inside the host's code; a real tick where no poller is armed. */
  private hostTick(host: string): Promise<void> {
    const poller = this.hostPollers.get(host);
    if (!poller) return realTick();
    return new Promise((resolve) => poller.waiters.push(resolve));
  }

  /**
   * The invocation a timer set now belongs to: a host's timers are the
   * host's, its continuation's, inside a call or after it, so the caller's
   * crash does not cancel them and a crash of the host's work does.
   */
  private timerOwner(): string {
    const ctx = hostScope?.getStore();
    if (ctx !== undefined) return this.continuationOf(ctx.host).id;
    return this.running();
  }

  /**
   * The host whose code is running after the effect it was entered by has
   * ended (or, where that effect is not known, while none of its effects is
   * being performed), if any: work after an answer.
   */
  private afterWorkHost(): string | undefined {
    const ctx = hostScope?.getStore();
    if (ctx === undefined) return undefined;
    const inside = ctx.frame ? ctx.frame.active : this.frames.liveHost(ctx.host) !== undefined;
    return inside ? undefined : ctx.host;
  }

  /**
   * The invocation a host's work after an answer runs as, `<host>/after`
   * (`#<n>` once the object was reset: a new instance's work is a new
   * invocation's), started on first use and alive until `settleAfterWork`;
   * work woken later revives it.
   */
  private continuationOf(host: string): InvocationState {
    let cont = this.continuations.get(host);
    if (!cont) {
      const n = (this.continuationCounts.get(host) ?? 0) + 1;
      this.continuationCounts.set(host, n);
      cont = this.track(`${host}/after${n > 1 ? `#${n}` : ""}`);
      this.continuations.set(host, cont);
      if (this.concurrent) this.turns.started(cont.id);
    }
    if (!cont.isCrashed()) this.afterWork.add(cont);
    return cont;
  }

  hostReset(host: string): void {
    this.hostAbandoned(host);
  }

  private instanceOf(host: string): number {
    return this.resetCounts.get(host) ?? 0;
  }

  /** Whether the instance is gone: its host was reset since it began. */
  private isGone(instance: Instance | undefined): boolean {
    return instance !== undefined && this.instanceOf(instance.host) !== instance.instance;
  }

  /**
   * The host was reset (`onAbandon` ran: a crash inside its code, an effect
   * of its that hung; or the platform dropped the instance, `hostReset`): its
   * work after an answer is gone with the instance, timers included, and its
   * poller with it.
   */
  private hostAbandoned(host: string): void {
    this.hostPollers.delete(host);
    const old = this.instanceOf(host);
    this.resetCounts.set(host, old + 1);
    // A Worker the instance called runs in the instance's context: its code went with it, so its
    // invocation ends here (its timers with it, and what it had in flight inside other objects
    // is theirs now), and nothing waits for it any longer.
    for (const [id, within] of [...this.hostedWithin]) {
      if (within.host !== host || within.instance !== old) continue;
      this.invocations.get(id)?.crash();
      this.hosts.delete(id);
      this.hostedWithin.delete(id);
    }
    // A call into the host whose code had started was running in the instance that is gone: that
    // code will not answer. Where the caller is alive the runtime fails the call and the caller
    // ends it; one nobody is left to end (its caller was reset before) ends here.
    for (const frame of this.frames.into(host)) {
      if (!(frame.entered || frame.entering > 0)) continue;
      this.frames.adjust(frame, () => {
        frame.codeGone = true;
      });
      if (frame.orphaned) frame.end();
    }
    // What the host's code was awaiting went with it: an effect it made that is still being
    // performed will never be seen to end. A call it made into another object whose code is
    // running goes on there, as that object's own work from now on (what the code still does is
    // an answer to nobody), and is ended when that code answers; anything else ends here: a
    // call it made into itself, whose code went with it too, and a call into an object that
    // was reset since the call entered it.
    for (const frame of this.frames.issuedBy(host)) {
      const elsewhere = frame.host !== undefined && frame.host !== host;
      if (elsewhere && frame.entered && !frame.answered && !frame.codeGone) {
        frame.orphaned = true;
        // Its own deadline is awaited in the caller's context, which is gone or going: the run
        // times it from now, the same wherever it runs (`watchOrphans`).
        frame.untime();
        if (!this.orphans.has(frame)) this.orphans.set(frame, null);
        if (frame.host !== undefined && !this.adopted.has(frame)) {
          const work = this.continuationOf(frame.host);
          this.adopted.set(frame, work);
          if (this.concurrent) this.turns.adopt(frame, work);
        }
      } else frame.end();
    }
    const cont = this.continuations.get(host);
    if (!cont) return;
    this.continuations.delete(host);
    this.afterWork.delete(cont);
    cont.crash();
  }

  /**
   * Put the orphaned calls not yet timed under the real-time budget. What
   * timed such a call was awaiting it in its caller's context, which went
   * with the caller, so the run times it instead, from here: its own loops
   * ask whose timers may fire on every tick while anything is in flight,
   * in a context no reset tears down. A call whose code never answers ends
   * as any effect past the budget does: the run is UNSUPPORTED and the
   * called object is reset.
   */
  private watchOrphans(): void {
    for (const [frame, watched] of this.orphans) {
      if (watched) continue;
      const budgetMs = this.options.bounds.budgetMs;
      const deadline = realDeadline(budgetMs);
      this.orphans.set(frame, deadline);
      void deadline.expired.then(() => {
        if (!frame.active || this.orphans.get(frame) !== deadline) return;
        this.unsupported(
          `${frame.target} ${frame.op} did not complete within ${budgetMs} ms of real time`,
        );
        this.adopted.get(frame)?.crash();
        frame.abandon();
        frame.end();
        if (this.concurrent) this.progressed();
      });
    }
  }

  /**
   * A host's effect ended: work its code left outstanding (effects parked or
   * performing, timers pending, real work tracked) is the host's own now,
   * its continuation's, which owns the outstanding effects from here on
   * (see `ownerOf`): the caller's crash does not end them, and a fault in
   * them is the object's.
   */
  private leftHost(frame: Frame): void {
    // An abandoned effect reset the object, and a reset takes the code of every call inside the
    // object: what that code left outstanding died with the instance.
    if (frame.host === undefined || frame.isAbandoned || frame.codeGone) return;
    this.hostFrames.set(frame.host, frame);
    const effects = frame.children > 0 || frame.performing > 0;
    if (
      !effects &&
      !this.patched?.clock.hasTimerIn(frame.host) &&
      (this.hostIo.get(frame.host) ?? 0) === 0
    ) {
      // Nothing outstanding: the object's work has settled, so a heartbeat is counted from here (a
      // call that slept once is not one, however many such calls one handler makes).
      const cont = this.continuations.get(frame.host);
      if (cont) this.afterWorkTimers.delete(cont.id);
      return;
    }
    const cont = this.continuationOf(frame.host);
    if (!effects) return;
    this.adopted.set(frame, cont);
    if (this.concurrent) this.turns.adopt(frame, cont);
  }

  /**
   * Who owns an effect of `inv`'s made inside `enclosing`: `inv`, unless the
   * enclosing effect was a host's, ended while this one was outstanding and
   * handed it to the host's work after its answer (`leftHost`). The call's
   * invocation may be long finished or crashed then; the object goes on.
   */
  private ownerOf(inv: InvocationState, enclosing: Frame | undefined): InvocationState {
    const adopted = enclosing && this.adopted.get(enclosing);
    return adopted && enclosing.invocation === inv.id ? adopted : inv;
  }

  /**
   * A timer of a continuation's fired, by whichever path: its count against
   * `afterWorkTimerLimit` since its work last settled; past it the object's
   * work does not settle, so the run is UNSUPPORTED and the work ends (its
   * timers with it).
   */
  private timerFired(owner: string): void {
    let cont: InvocationState | undefined;
    for (const c of this.continuations.values()) if (c.id === owner) cont = c;
    if (!cont || cont.isCrashed()) return;
    const n = (this.afterWorkTimers.get(owner) ?? 0) + 1;
    this.afterWorkTimers.set(owner, n);
    if (n <= afterWorkTimerLimit) return;
    this.unsupported(
      `${owner}: the object's work after its answer fired its timers ${n} times and does not settle (an interval or a timer that re-arms itself); the model waits for such work only up to ${afterWorkTimerLimit} firings without it settling`,
    );
    this.afterWork.delete(cont);
    cont.crash();
  }

  /** A host's timers fired and not yet run by their pollers inside it: work on its way. */
  private firedPending(): number {
    return this.patched?.clock.firedPending() ?? 0;
  }

  /** Whether an object's work after an answer may still move; the run does not end while it may. */
  hasAfterWork(): boolean {
    for (const cont of this.afterWork) if (!cont.isCrashed()) return true;
    return false;
  }

  /**
   * Nothing can move (no effect in flight, no turn to take, no timer due):
   * every continuation alive has settled, as an object with nothing pending
   * goes idle. How many did; work of theirs woken later revives them.
   */
  settleAfterWork(): number {
    const n = this.afterWork.size;
    // Settled: a heartbeat is counted from here (an object that sleeps once per call is not one).
    for (const cont of this.afterWork) this.afterWorkTimers.delete(cont.id);
    this.afterWork.clear();
    return n;
  }

  /**
   * Sequential runs: between deliveries, let objects' work after their
   * answers run to rest, as it does in the runtime while nothing else comes
   * in: real I/O completes, timers fire in due order, and once nothing of it
   * can move it has settled.
   */
  async driveAfterWork(): Promise<void> {
    // Whether the last tick too found only idle hosting effects in flight (see `timersAllowed`).
    let idleBefore = false;
    while (this.hasAfterWork()) {
      if (this.firedPending() > 0) {
        idleBefore = false;
        await realTick();
        continue;
      }
      if (this.frames.inFlight > 0) {
        // The work called into an object that awaits a timer of its own before it answers: after a
        // tick for anything the run cannot see, the timer fires.
        const allowed = this.timersAllowed();
        if (allowed && idleBefore && this.fireOwned(allowed) !== undefined) {
          idleBefore = false;
          await eventLoopTurn();
        } else {
          idleBefore = allowed !== null;
          await realTick();
        }
        continue;
      }
      idleBefore = false;
      // Only the work's own timers: a finished handler's stray timer is not the object's to run.
      if (this.fireAfterWorkTimer()) {
        await eventLoopTurn();
        continue;
      }
      // One turn of the event loop for code that what just completed resumed; then it is at rest.
      await realTick();
      if (this.frames.inFlight > 0 || this.firedPending() > 0 || this.fireAfterWorkTimer())
        continue;
      this.settleAfterWork();
    }
  }

  /** Fire the next due timer of an object's work after an answer, as that work. False when none is pending. */
  fireAfterWorkTimer(): boolean {
    const alive = this.aliveAfterWork();
    if (alive.size === 0) return false;
    return this.fireOwned((owner) => owner !== null && alive.has(owner)) !== undefined;
  }

  /**
   * Whose timers may fire now: anyone's while nothing is in flight; while
   * only hosting effects whose hosted code is idle are, and one of those
   * hosts has a timer pending (an object awaiting a timer of its own before
   * it answers, see `Frames.idleHosts`), the timers of those hosts' work;
   * nobody's otherwise: a fired timer not yet run, or idle hosted code with
   * no timer, is work on its way that the run cannot see yet (a call
   * crossing into the object, storage I/O).
   */
  private timersAllowed(): ((owner: string | null) => boolean) | null {
    if (this.orphans.size > 0) this.watchOrphans();
    const clock = this.patched?.clock;
    if (!clock || this.firedPending() > 0) return null;
    if (this.frames.inFlight === 0) return () => true;
    const hosts = this.frames.idleHosts();
    if (!hosts) return null;
    const owners = new Set<string>();
    for (const host of hosts) {
      const cont = this.continuations.get(host);
      if (cont) owners.add(cont.id);
    }
    const allowed = (owner: string | null): boolean => owner !== null && owners.has(owner);
    // Only a timer of the hosts' own says the idle code is waiting for one; a pending deadline alone
    // does not (the code may be doing real I/O the run cannot see yet), though once timers may fire
    // the deadline fires with them.
    // A known limit: an object napping inside a late attempt's call holds the invocation's own
    // timers too (its retry waits for the object to wake), though the attempt's work holds nothing.
    return clock.nextDueOwned(allowed, false) === undefined ? null : allowed;
  }

  /**
   * Fire the earliest due timer whose owner `allowed` accepts, as that owner
   * (a step of a concurrent run). The owner it fired as (null for none);
   * undefined when no such timer is pending.
   */
  private fireOwned(allowed: (owner: string | null) => boolean): string | null | undefined {
    const clock = this.patched?.clock;
    if (!clock) return undefined;
    const owner = clock.nextOwnerOwned(allowed);
    if (owner === undefined) return undefined;
    this.runAs(owner);
    if (this.concurrent) this.turns.step();
    clock.fireNextOwned(allowed);
    return owner;
  }

  /**
   * Wait until what is running has come to rest: fired timers run and real
   * I/O done; or, two turns of the event loop running, only hosting effects
   * whose code is idle in flight (an object awaiting a timer of its own
   * before it answers), which the next timer to fire is for.
   */
  private async rest(): Promise<void> {
    let idleBefore = false;
    for (;;) {
      await eventLoopTurn();
      if (this.firedPending() > 0) {
        idleBefore = false;
        continue;
      }
      if (this.frames.inFlight === 0) return;
      const idle = this.timersAllowed() !== null;
      if (idle && idleBefore) return;
      idleBefore = idle;
    }
  }

  private runAs(id: string | null): void {
    if (this.patched) this.patched.clock.owner = id;
    if (id !== null) this.current = id;
  }

  bookkeeping(): string {
    if (!this.invocations.has(bookkeepingId)) this.track(bookkeepingId);
    return bookkeepingId;
  }

  private track(id: string): InvocationState {
    if (this.invocations.has(id)) throw new Error(`invocation ${id} already started`);
    const inv = new InvocationState(id, (inside) => {
      this.patched?.clock.cancelOwner(id);
      this.adoptInFlight(id, inside);
    });
    this.invocations.set(id, inv);
    return inv;
  }

  /**
   * The invocation crashed with calls into objects still in flight (a late
   * attempt's call while the retry's effect took the fault): the objects go
   * on, as the runtime's do, so what their code still does is their own work
   * (`ownerOf`), an answer to a caller that is gone. The call the crash
   * happened inside (`inside`) is abandoned by the crash instead and resets
   * its object.
   */
  private adoptInFlight(id: string, inside?: Frame): void {
    for (const frame of this.frames.hostingOf(id)) {
      if (frame === inside || frame.isAbandoned || frame.host === undefined) continue;
      if (this.adopted.has(frame)) continue;
      const cont = this.continuationOf(frame.host);
      this.adopted.set(frame, cont);
      if (this.concurrent) this.turns.adopt(frame, cont);
    }
  }

  private invocation(id: string): InvocationState {
    const inv = this.invocations.get(id);
    if (!inv) throw new Error(`effect from unknown invocation ${id}`);
    return inv;
  }

  /** Effect points so far that could take a fault (the positions a seeded chooser's plan counts). */
  get eligiblePoints(): number {
    return this.eligibleSeen;
  }

  /** The fault at an eligible point, if any: the chooser's pick among none and the allowed kinds. */
  private decide(point: EffectPoint, ordinal: number): FaultKind | null {
    if (point.allowed.length === 0) return null;
    this.eligibleSeen++;
    const at = { invocation: point.invocation, ordinal };
    const i = this.options.chooser.choose("fault", [
      { label: "none", ...at },
      ...point.allowed.map((fault) => ({ label: fault, ...at })),
    ]);
    return i === 0 ? null : (point.allowed[i - 1] ?? null);
  }

  /** Append one record, with the next sequence number: O(1), so a long run's log stays cheap. */
  private append(effect: Omit<EffectRecord, "seq">): void {
    this.entries.push({ ...effect, seq: this.entries.length });
    this.logView = null;
  }

  private record(point: EffectPoint, kind: "call" | "result" | "fault", payload: JsonValue): void {
    if (kind === "result") this.turns.performed(point.target);
    this.append({
      kind,
      invocation: point.invocation,
      target: point.target,
      op: point.op,
      payload,
    });
  }

  /** Open an effect point: record the call and decide the fault. */
  private open(point: EffectPoint, inv: InvocationState): FaultKind | null {
    this.effectIndex++;
    const ordinal = inv.ordinal++;
    this.record(point, "call", { args: point.args });
    const fault = this.decide(point, ordinal);
    if (fault) {
      this.faults.push({
        invocation: point.invocation,
        ordinal,
        fault,
        target: point.target,
        op: point.op,
      });
    }
    return fault;
  }

  async effect<T>(
    point: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
    options: EffectOptions = {},
  ): Promise<T> {
    const ctx = hostScope?.getStore();
    // The instance whose context this code runs in, if any: an object's own code, or a Worker's
    // that an object called. Code of an instance that was reset does not run in the runtime; where
    // it still does (a fake one, or a timer the run fired for it) it makes no effect.
    const inside: Instance | undefined = ctx ?? this.hostedWithin.get(point.invocation);
    const gone = (): boolean => this.isGone(inside);
    if (gone()) return hang();
    /** A host's code inside a call of its: that call. */
    let call: Frame | undefined;
    if (ctx !== undefined) {
      const { host } = ctx;
      // The call this code is, while its effect is being performed; where the call is not known, the
      // innermost of the host's effects being performed.
      const live = ctx.frame
        ? ctx.frame.active
          ? ctx.frame
          : undefined
        : this.frames.liveHost(host);
      call = live;
      if (live) {
        // A host's code inside one of its effects: the effect is that one's, whatever invocation the
        // platform named (the runtime carries no context of the caller's into the host's code).
        if (live.invocation !== point.invocation)
          return this.effect(
            { ...point, invocation: live.invocation },
            perform,
            summarize,
            options,
          );
      } else {
        // The host's work after its answer: an effect of its continuation, a turn of its own, waited
        // for by polling as hosted code's effects are (the code runs inside the object); a crash in
        // it resets the object through the ended effect's onAbandon and ends the continuation.
        const cont = this.continuationOf(host);
        const own = { ...point, invocation: cont.id };
        if (cont.isCrashed()) return hang();
        const ended = ctx.frame ?? this.hostFrames.get(host);
        // Inside blockConcurrencyWhile nothing else enters the object and nothing it waits for gets
        // in, its poller's ticks included: the effect runs at once, as a call's would.
        if (this.concurrent && (ended?.mayPark() ?? true)) {
          let released = false;
          this.turns.park(cont, own.target, () => {
            released = true;
            this.releasedTo(host);
          });
          // Waited for on the host's poller's ticks: a real timer the host's code armed here, after
          // its request completed, would keep the object referenced (workerd), as the poller, armed
          // inside the request and re-armed from its own ticks, does not.
          while (!released && !cont.isCrashed()) await this.hostTick(host);
          if (!released) return hang();
        }
        return this.performEffect(own, perform, summarize, options, cont, ended);
      }
    }
    const inv = this.invocation(point.invocation);
    // An effect made inside another's perform (an object calling out during a call) is part of
    // that effect's turn: parking it would wait for the outer one, which waits for it.
    // Hosted code's effect is inside the call that code is, whichever of the invocation's calls
    // into objects started last.
    const enclosing = this.frames.enclosing(point.invocation, ctx !== undefined, call);
    // Whose effect it is (the object's own once its call was handed over, see `ownerOf`): a crashed
    // owner's effect hangs.
    if (this.ownerOf(inv, enclosing).isCrashed()) return hang();
    const nested = enclosing !== undefined;
    if (this.concurrent && !nested) {
      const host = this.hosts.get(point.invocation);
      if (host?.active) {
        // Code another invocation's effect hosts (a called Worker's): a turn of its own, during which the
        // host waits on it; while it performs, the host is in flight again. Nothing cuts this code off
        // from async context, so a promise settled from outside wakes it, unless the Worker was
        // called from inside an object: its code then runs in the object's I/O context, where a
        // promise settled from outside resumes it in the wrong one (workerd), so it waits on the
        // object's poller, as the object's own effects do.
        const within = this.hostedWithin.get(point.invocation)?.host;
        if (within !== undefined) this.pollHost(within);
        return this.hostedTurn(
          point,
          perform,
          summarize,
          options,
          inv,
          undefined,
          host,
          gone,
          within === undefined
            ? (park) => new Promise<boolean>((go) => park(() => go(true)))
            : async (park, crashed) => {
                let released = false;
                park(() => {
                  released = true;
                  this.releasedTo(within);
                });
                while (!released && !crashed()) await this.hostTick(within);
                return released;
              },
        );
      }
      await new Promise<void>((go) =>
        this.turns.park(inv, point.target, go, undefined, this.attemptNow()),
      );
      if (inv.isCrashed()) return hang();
    } else if (this.concurrent && enclosing?.hosts && enclosing.mayPark()) {
      // Hosted code calling out (an object's fetch during a call) is a turn too: the object's
      // input gate is open meanwhile, so another call into it may run first. While all such
      // effects of the host are parked the host is waiting, not performing I/O.
      return this.hostedTurn(
        point,
        perform,
        summarize,
        options,
        inv,
        enclosing,
        enclosing,
        gone,
        async (park, crashed) => {
          // Wait by polling a flag from inside the hosted code: no promise is settled from outside
          // it (workerd refuses that for a Durable Object), and no event has to enter it (its input
          // gate may be closed, as in blockConcurrencyWhile). On the host's poller's ticks where the
          // code is a host's: a real timer of its own armed after its answer crossed would keep the
          // object referenced (see `pollHost`).
          let released = false;
          const host = enclosing.host;
          park(() => {
            released = true;
            this.releasedTo(host);
          });
          while (!released && !crashed())
            await (host === undefined ? realTick() : this.hostTick(host));
          return released;
        },
      );
    }
    return this.performEffect(point, perform, summarize, options, inv, enclosing);
  }

  /**
   * An effect that is a turn under `host` (the effect hosting the invocation, or the hosted code's
   * own enclosing effect): the host waits on it until `wait` gives it the turn, and is in flight
   * again while it performs. `wait` parks the effect through `park` and answers whether the turn
   * came; when it did not (the invocation crashed meanwhile) the effect hangs.
   */
  private async hostedTurn<T>(
    point: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
    options: EffectOptions,
    inv: InvocationState,
    enclosing: Frame | undefined,
    host: Frame,
    /** Whether the code making the effect belongs to an instance that was reset since. */
    gone: () => boolean,
    wait: (park: (go: () => void) => void, crashed: () => boolean) => Promise<boolean>,
  ): Promise<T> {
    this.childStarts(host);
    // Whose turn it waits for: the host's work's once the hosting effect has answered or its caller
    // crashed (`ownerOf`); adoption while parked re-points the turn (`Turns.adopt`).
    const owner = this.ownerOf(inv, enclosing);
    const crashed = (): boolean => gone() || this.ownerOf(inv, enclosing).isCrashed();
    const attempt = this.attemptNow(enclosing, host);
    // The scheduler marks the turn as on its way to the code (`Frame.arriving`) when it gives it.
    let given = false;
    let over = false;
    const arrived = (): void => this.frames.adjust(host, () => host.arriving--);
    const came = await wait(
      (go) =>
        this.turns.park(
          owner,
          point.target,
          () => {
            given = true;
            // Given to code that stopped waiting (its invocation crashed): nothing is on its way.
            if (over) arrived();
            go();
          },
          host,
          attempt,
          gone,
        ),
      crashed,
    );
    over = true;
    // The turn has arrived, or will not be taken: either way it is on its way no longer. From here to
    // the effect performing (or dying of its fault) nothing else runs.
    if (given) arrived();
    // Code whose instance was reset does nothing more, its own bookkeeping included: in the runtime
    // this line is never reached in it, so nothing may depend on it being reached anywhere. The
    // call the code was inside of is the caller's to end (`Frame.codeGone`).
    if (gone()) return hang();
    if (!came) {
      this.childEnds(host);
      return hang();
    }
    try {
      return await this.performEffect(point, perform, summarize, options, inv, enclosing, host);
    } finally {
      this.childEnds(host);
    }
  }

  /** A child of `host` started: an effect waiting for its turn under it, or an invocation hosted inside it. */
  private childStarts(host: Frame): void {
    this.frames.adjust(host, () => host.children++);
  }

  /** A child of `host` ended. */
  private childEnds(host: Frame): void {
    this.frames.adjust(host, () => host.children--);
  }

  /** The effect once it has its turn: the fault, the perform under its deadline, the record. */
  private async performEffect<T>(
    made: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
    options: EffectOptions,
    inv: InvocationState,
    enclosing: Frame | undefined,
    /** The hosting effect this one waited for a turn under, which waits on it while it waits. */
    host?: Frame,
  ): Promise<T> {
    // A crash hangs this effect; inside another effect's perform it ends that effect too (a host's
    // that has ended resets the object).
    const dead = (): Promise<T> => {
      enclosing?.crash();
      return hang();
    };
    // Whose effect this is now: the object's code issued it during a call that has since answered,
    // it is the object's work (`ownerOf`), opened and recorded as such when it opens after the answer.
    const owner = (): InvocationState => this.ownerOf(inv, enclosing);
    const opener = owner();
    const point = opener === inv ? made : { ...made, invocation: opener.id };
    const fault = this.open(point, opener);
    const before = this.faultBefore(point, opener, fault, enclosing);
    if (before === "crashed") return dead();
    if (before) throw before;
    let settled:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }
      | "expired"
      | "nested_crash";
    // Real I/O that outlasts the scenario's whole budget is treated as hung, so the run ends.
    const deadline = realDeadline(this.options.bounds.budgetMs);
    const frame = new Frame(point, options);
    frame.onHostAbandoned = (h) => this.hostAbandoned(h);
    frame.parent = host;
    frame.attempt = this.attemptNow(enclosing, host);
    // A host's code, or a Worker's hosted from inside one: it runs in that object's context.
    frame.issuer = (hostScope?.getStore() ?? this.hostedWithin.get(made.invocation))?.host;
    this.frames.enter(frame);
    if (enclosing) this.frames.adjust(enclosing, () => enclosing.performing++);
    let ended = false;
    frame.untime = () => deadline.cancel();
    frame.end = (): void => {
      if (ended) return;
      ended = true;
      deadline.cancel();
      this.orphans.get(frame)?.cancel();
      this.orphans.delete(frame);
      if (enclosing) this.frames.adjust(enclosing, () => enclosing.performing--);
      this.frames.leave(frame);
      this.leftHost(frame);
    };
    try {
      const inside = (): Promise<T> => (effectScope ? effectScope.run(frame, perform) : perform());
      // The library's own timers inside the I/O are real; the handler's stay virtual.
      const io = this.patched ? this.patched.libraryIo(inside) : inside();
      settled = await Promise.race([
        io.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        deadline.expired,
        frame.crashed,
      ]);
    } catch (err) {
      // `perform` threw before returning a promise.
      settled = { ok: false, error: err };
    } finally {
      frame.end();
      this.patched?.clock.advance(effectLatencyMs);
      if (this.concurrent) this.progressed();
    }
    // A crash inside it: whichever of the signal and the perform's own end woke this line (the reset
    // of the object the crash happened in rejects the call into it, and in the runtime that
    // rejection can arrive first where the signal was raised in another object's context), the
    // effect ended by the crash, so what encloses it ends too and nothing is recorded as its result.
    if (frame.wasCrashed) settled = "nested_crash";
    // Its caller was reset while the called object's code ran: nobody is left to take the answer,
    // here as where the runtime tore the caller's context down and this line is never reached.
    if (frame.orphaned) return hang();
    if (settled === "expired") {
      this.unsupported(
        `${point.target} ${point.op} did not complete within ${this.options.bounds.budgetMs} ms of real time`,
      );
      owner().crash();
      frame.abandon();
      return hang();
    }
    // A crash injected into an effect made during this one: it ends this one too, and outwards.
    // The frame already told the effect's onAbandon, from where the crash happened.
    if (settled === "nested_crash") return dead();
    if (!settled.ok) {
      this.record(point, "result", {
        args: point.args,
        result: null,
        error: String(settled.error),
      });
      throw settled.error;
    }
    const value = settled.value;
    this.record(point, "result", { args: point.args, result: summarize(value) });
    // The effect committed while its owner was dying: nothing after it runs.
    if (owner().isCrashed()) return hang();
    const after = this.faultAfter(point, owner(), fault, enclosing);
    if (after === "crashed") return dead();
    if (after) throw after;
    return value;
  }

  /** A fault decided before the effect performs: the crash it is, the error to throw, or nothing. */
  /**
   * A fault decided before the effect performs: the crash it is, the error to
   * throw, or nothing. The crash names the effect the point is nested in
   * (an object's call the crash happened inside, which `dead` then abandons,
   * resetting the object), so it is not handed to the object (`adoptInFlight`).
   */
  private faultBefore(
    point: EffectPoint,
    inv: InvocationState,
    fault: FaultKind | null,
    enclosing?: Frame,
  ): "crashed" | InjectedEffectError | null {
    if (fault === "crash_before" || fault === "cut_off") {
      this.recordFault(point, fault);
      inv.crash(enclosing);
      return "crashed";
    }
    if (fault === "error") {
      this.recordFault(point, fault);
      return new InjectedEffectError(point, fault);
    }
    return null;
  }

  /** A fault decided after the effect committed: the crash it is, the error to throw, or nothing. */
  private faultAfter(
    point: EffectPoint,
    inv: InvocationState,
    fault: FaultKind | null,
    enclosing?: Frame,
  ): "crashed" | InjectedEffectError | null {
    if (fault === "crash_after") {
      this.recordFault(point, fault);
      inv.crash(enclosing);
      return "crashed";
    }
    if (fault === "ambiguous") {
      this.recordFault(point, fault);
      return new InjectedEffectError(point, fault);
    }
    return null;
  }

  private recordFault(point: EffectPoint, fault: FaultKind): void {
    this.record(point, "fault", { args: point.args, fault });
  }

  effectSync<T>(point: EffectPoint, perform: () => T, summarize: (value: T) => JsonValue): T {
    const inv = this.invocation(point.invocation);
    if (inv.isCrashed()) throw new CrashSignal(inv.id);
    const fault = this.open(point, inv);
    const before = this.faultBefore(point, inv, fault);
    if (before === "crashed") throw new CrashSignal(inv.id);
    if (before) throw before;
    let value: T;
    try {
      value = perform();
    } catch (err) {
      this.record(point, "result", { args: point.args, result: null, error: String(err) });
      throw err;
    }
    this.record(point, "result", { args: point.args, result: summarize(value) });
    const after = this.faultAfter(point, inv, fault);
    if (after === "crashed") throw new CrashSignal(inv.id);
    if (after) throw after;
    return value;
  }

  unsupported(reason: string): void {
    this.reasons.push(reason);
  }

  attempt<T>(invocation: string, code: () => T, deadlineMs: number): Attempt<T> {
    const cell: AttemptCell = { late: deadlineMs <= 0 };
    let giveUp: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      giveUp = () => {
        cell.late = true;
        resolve();
      };
    });
    if (cell.late) giveUp();
    const value = attemptScope ? attemptScope.run(cell, code) : code();
    // The deadline is a virtual timer of the invocation's set by the run, not through the patched
    // global: it is no read of the clock by the code (the partial-order reduction stays on), and it
    // is cleared once the code settles in time. Without a clock installed, the attempt is never late.
    const clock = this.patched?.clock;
    if (!cell.late && clock) {
      const timer = clock.setTimeoutAs(invocation, giveUp, deadlineMs);
      const clear = (): void => clock.clear(timer);
      if (isThenable(value)) void Promise.resolve(value).then(clear, clear);
      else clear();
    }
    return { value, late };
  }

  /**
   * The attempt whose code is running now, by its async context or, where the
   * runtime carries none (an object's code), by the effect it runs inside of.
   * Read live where it is kept: an attempt may become late after its effect
   * parked or entered an object.
   */
  private attemptNow(...frames: (Frame | undefined)[]): AttemptCell | undefined {
    return attemptScope?.getStore() ?? frames.find((f) => f?.attempt)?.attempt;
  }

  settle<T>(promise: Promise<T>, invocation: string): Promise<T> {
    const inv = this.invocation(invocation);
    // In a concurrent run the run itself fires timers and detects a stuck run (see `quiesce`). A crash
    // is seen on the run's own step, not through a promise settled where it happened: an object's
    // task being torn down by its reset may never wake what it settled.
    if (this.concurrent)
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          if (inv.isCrashed()) reject(new CrashSignal(inv.id));
          else this.crashWatch.push({ inv, reject });
        }),
      ]);
    const patched = this.patched;
    // A hosted invocation is known by its cell, never by `current`: the caller's own code may still
    // run beside it (two calls awaited together) and must stay the caller's.
    if (!this.hosts.has(invocation)) this.runAs(invocation);
    if (!patched) {
      // Globals not installed (direct use outside runOnce): just wait, abandoning on crash.
      return Promise.race([promise, inv.crashed.then(() => hang<T>())]);
    }
    return settleOn(promise, {
      clock: patched.clock,
      // An invocation hosted inside one of this one's effects is work of this one's, which its own
      // settle drives: not a timer to fire here, nor a reason to call this one stuck.
      inFlight: () => this.frames.inFlight + this.hostedBy(invocation) + this.firedPending(),
      // While its own effect hosts an object awaiting a timer of its own, that timer fires; a hosted
      // invocation's settle is the one to fire timers while it runs.
      idle: () => (this.hostedBy(invocation) > 0 ? null : this.timersAllowed()),
      crashed: () => inv.isCrashed(),
      crashError: () => new CrashSignal(invocation),
      stuck: () => {
        // Nothing can make progress: report it and abandon the invocation so the run can end.
        this.unsupported(waitingUnseen(invocation));
        inv.crash();
      },
    });
  }

  /**
   * Run `work` as the code of a new invocation `id` inside the effect being
   * performed now (see `hostInvocation`): the invocation is started in a
   * delivery context of its own, so async context attributes its effects to
   * it while the host's own code stays the host's, the hosting effect waits
   * on it without counting as I/O of its own (the hosted code's effects and
   * tracked work count), and the hosting invocation is the running one again
   * once it ends. A fault that crashes `id` ends `id` alone: nothing here
   * tells the host's frame, so what the host sees is `work`'s to decide.
   */
  async hosted<T>(id: string, work: (inv: Invocation) => Promise<T>): Promise<T> {
    const frame = this.frames.current();
    if (!frame)
      throw new Error(`invocation ${id} can only be hosted inside an effect being performed`);
    if (!deliveryScope)
      throw new Error("hosting an invocation needs AsyncLocalStorage (node:async_hooks)");
    // The object whose code is hosting it, if any (an object calling another Worker), or the one
    // the invocation hosting it runs inside of: the hosted code runs in that object's I/O context.
    const here = hostScope?.getStore();
    const within: Instance | undefined = here
      ? { host: here.host, instance: here.instance }
      : this.hostedWithin.get(frame.invocation);
    const run = async (): Promise<T> => {
      // Tracked, not made the running one: the hosted code is known by its own cell, so the caller's
      // code that goes on meanwhile (a second call awaited together) stays the caller's.
      const inv = this.track(id);
      if (this.concurrent) this.turns.started(id);
      this.hosts.set(id, frame);
      if (within !== undefined) this.hostedWithin.set(id, within);
      this.childStarts(frame);
      try {
        return await work(inv);
      } finally {
        this.childEnds(frame);
        this.hosts.delete(id);
        this.hostedWithin.delete(id);
      }
    };
    // Inside an effect's perform the library's timers are real; the hosted code is handler code, so
    // its timers are virtual again, and it runs in a delivery context of its own in either mode.
    const asHandler = (): Promise<T> => (this.patched ? this.patched.handlerCode(run) : run());
    // A called Worker's code is its own, not the object's that may have called it.
    const unhosted = (): Promise<T> =>
      hostScope ? hostScope.run(undefined, asHandler) : asHandler();
    return deliveryScope.run({ id }, unhosted);
  }

  /** How many invocations are hosted inside effects of `invocation` now. */
  private hostedBy(invocation: string): number {
    let n = 0;
    for (const frame of this.hosts.values()) if (frame.invocation === invocation) n++;
    return n;
  }

  /** Concurrent runs: start a delivery in its own async context. */
  startDelivery<T>(deliver: () => Promise<T>): StartedDelivery<T> {
    if (!deliveryScope) throw new Error("concurrent invocations need AsyncLocalStorage");
    const cell: DeliveryCell = { id: null };
    this.runAs(null);
    const promise = deliveryScope.run(cell, deliver);
    return { promise, invocation: () => cell.id };
  }

  /** Concurrent runs: something moved (I/O completed, an event was queued). */
  progressed(): void {
    this.turns.progressed();
  }

  /** Concurrent runs: a delivery ended. */
  rested(): void {
    this.turns.rested();
  }

  /**
   * Concurrent runs: wait until what the last step set off (a turn
   * released, an event started, a timer fired) has parked, finished or
   * gone idle. Parking, a delivery ending and I/O completing wake the wait
   * at once, except while a Durable Object's code runs, which cannot wake
   * it (the wait's zero timer polls then); every continuation they set off
   * runs before it returns (one turn of the event loop), so code another
   * invocation's promise resumed reaches its own effect too. Code waiting
   * on anything else gets one such turn, the same allowance the sequential
   * path gives, before it counts as idle.
   */
  quiesce(): Promise<void> {
    this.releaseCrashed();
    return this.turns.quiesce();
  }

  /**
   * Concurrent runs: settles waiting on invocations that have crashed since
   * are released, on the run's own step. Returns the invocations released.
   */
  private releaseCrashed(): Set<string> {
    const released = new Set<string>();
    if (this.crashWatch.length === 0) return released;
    const waiting = this.crashWatch;
    this.crashWatch = [];
    for (const w of waiting) {
      if (w.inv.isCrashed()) {
        w.reject(new CrashSignal(w.inv.id));
        released.add(w.inv.id);
      } else this.crashWatch.push(w);
    }
    return released;
  }

  /**
   * Concurrent runs: pick the next turn among the parked invocations, when
   * `canStart` starting the next event, and the earliest virtual timer
   * already due that may fire now (`timersAllowed`; with `afterWorkOnly`,
   * only an object's work after its answer's, as `fireAfterWorkTimer`).
   * Parked invocations are ordered by start, then by when they parked, so
   * the pick does not depend on real-time arrival; timers keep their due
   * order among themselves. `canWait`: whether the loop could let time pass
   * if nothing were parked; while only late turns are, it is an option
   * (`Turns.takeTurn`). Returns what was picked; "turn" has already
   * released it, "timer" fired it, and "none" leaves the loop to let time
   * pass or give up.
   */
  takeTurn(
    canStart: boolean,
    afterWorkOnly = false,
    canWait = false,
  ): "turn" | "start" | "timer" | "none" {
    return this.turns.takeTurn(canStart, this.dueTimer(afterWorkOnly), canWait);
  }

  /** The earliest timer already due (at or before the virtual now) that may fire now, as a turn. */
  private dueTimer(afterWorkOnly: boolean): DueTimer | undefined {
    const clock = this.patched?.clock;
    const allowed = this.timersAllowed();
    if (!clock || !allowed) return undefined;
    const alive = afterWorkOnly ? this.aliveAfterWork() : null;
    const owned = alive
      ? (owner: string | null) => owner !== null && alive.has(owner) && allowed(owner)
      : allowed;
    const due = clock.nextDueOwned(owned);
    if (due === undefined || due > clock.now()) return undefined;
    const owner = clock.nextOwnerOwned(owned) ?? null;
    return {
      owner,
      fired: this.timersFired.get(owner) ?? 0,
      fire: () => {
        this.fireOwned(owned);
      },
    };
  }

  /**
   * Let virtual time pass until `at`: timers due by then fire first, in due
   * order, as the invocations that set them, each followed by the work it
   * sets off. No-op when `at` is not ahead. Returns whether a timer fired.
   */
  async advanceTo(at: number): Promise<boolean> {
    const clock = this.patched?.clock;
    if (!clock) return false;
    let fired = false;
    for (;;) {
      const allowed = this.timersAllowed();
      const due = allowed ? clock.nextDueOwned(allowed) : undefined;
      if (!allowed || due === undefined || due > at) break;
      this.fireOwned(allowed);
      fired = true;
      // What the timer set off runs at its own time, before the clock moves on.
      await this.rest();
    }
    clock.advance(at - clock.now());
    return fired;
  }

  /**
   * When the next virtual timer is due, or undefined when none is pending;
   * `afterWorkOnly` counts the timers of objects' work after answers alone,
   * the ones that fire while only such work is alive.
   */
  nextTimerDue(afterWorkOnly = false): number | undefined {
    const clock = this.patched?.clock;
    if (!clock) return undefined;
    if (!afterWorkOnly) {
      const allowed = this.timersAllowed();
      return allowed ? clock.nextDueOwned(allowed) : undefined;
    }
    const alive = this.aliveAfterWork();
    return clock.nextDueOwned((owner) => owner !== null && alive.has(owner));
  }

  /** The ids of continuations alive now. */
  private aliveAfterWork(): Set<string> {
    const alive = new Set<string>();
    for (const cont of this.afterWork) if (!cont.isCrashed()) alive.add(cont.id);
    return alive;
  }

  /**
   * Concurrent runs: fire the next due timer that may fire now
   * (`timersAllowed`) as the invocation that set it. False when none is.
   */
  fireTimer(): boolean {
    const allowed = this.timersAllowed();
    return allowed !== null && this.fireOwned(allowed) !== undefined;
  }

  /**
   * Concurrent runs: nothing can make progress; abandon these invocations so
   * the run can end. Returns how many were still alive, or how many crashes
   * were passed on first: an invocation that crashed inside an object (the
   * object's reset tears down the task the crash settled its promise in, so
   * what waited on it never saw it) has its settle released here, on the
   * run's own step. A crash released here is on its way to whatever waited
   * on it, which may be one of `ids` (an invocation waiting on a Worker it
   * called, which crashed inside an object): none of them is stuck until
   * that has landed, so nothing is abandoned in the same step.
   */
  abandon(ids: readonly string[]): number {
    const released = this.releaseCrashed();
    if (released.size > 0) return released.size;
    let abandoned = 0;
    for (const id of ids) {
      const inv = this.invocations.get(id);
      if (!inv || inv.isCrashed()) continue;
      this.unsupported(waitingUnseen(id));
      inv.crash();
      abandoned++;
    }
    return abandoned;
  }

  timersPending(invocation: string): boolean {
    return this.patched?.clock.nextDueOwned((owner) => owner === invocation, false) !== undefined;
  }

  /**
   * Whether everything in flight is idle code of hosts (see
   * `Frames.idleHosts`) one of which has an effect parked: a call that
   * awaits what another call of the same object started (a load the object
   * dedupes) is waiting on that call's effect, though it parked none of its
   * own. The run is at rest then, for the scheduler to give that effect its
   * turn; taken for busy, the call would wait for a turn nothing could give.
   */
  private idleBehindParked(): boolean {
    const hosts = this.frames.idleHosts();
    return hosts !== null && this.turns.parkedFor(hosts);
  }

  /** Whether the invocation of this id has crashed; one never started has not. */
  hasCrashed(id: string | null): boolean {
    return id !== null && (this.invocations.get(id)?.isCrashed() ?? false);
  }

  /**
   * Concurrent runs: wait in real time until one of these deliveries ends,
   * within the scenario's budget. False when there is none to wait for or
   * none ended in time.
   */
  async ended(deliveries: readonly Promise<unknown>[]): Promise<boolean> {
    if (deliveries.length === 0) return false;
    const deadline = realDeadline(this.options.bounds.budgetMs);
    const over = () => "ended" as const;
    try {
      const first = await Promise.race([
        ...deliveries.map((d) => d.then(over, over)),
        deadline.expired,
      ]);
      return first === "ended";
    } finally {
      deadline.cancel();
    }
  }

  /** A call of a pure core function, recorded as a decision of the invocation running now (see `observeCore`). */
  decision(fn: string, payload: JsonValue): void {
    this.append({
      kind: "result",
      invocation: this.running(),
      target: decisionTarget(fn),
      op: "decide",
      payload,
    });
  }

  snapshot(invocation: string, target: string, payload: JsonValue): void {
    this.append({
      kind: "snapshot",
      invocation,
      target,
      op: "snapshot",
      payload,
    });
  }
}
