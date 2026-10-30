/**
 * One run of a scenario: the effect log being built, the fault decisions
 * (drawn during exploration, looked up during replay), and the invocations
 * in flight. Proxies in the platform package call `effect`/`effectSync`
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
  appendEffect,
  type Bounds,
  decideFault,
  decisionTarget,
  type EffectLog,
  type EffectOptions,
  type EffectPoint,
  type EventRef,
  type ExternalDecl,
  emptyLog,
  type FaultDecision,
  type FaultKind,
  type Invocation,
  type JsonValue,
  nextInt,
  type PrngState,
  type RunHooks,
  type Schedule,
  seedPrng,
} from "@eutaxy/core";
import {
  effectLatencyMs,
  eventLoopTurn,
  type Patched,
  patchGlobals,
  realDeadline,
  realTick,
  settleOn,
  type VirtualClock,
} from "./clock.ts";
import { asyncScope } from "./context.ts";
import { installScriptedFetch } from "./fetch.ts";
import { effectScope, Frame, Frames } from "./frames.ts";
import { Turns } from "./turns.ts";

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

/** One option at a decision the run cannot make by itself. */
export interface ChoiceOption {
  /** Names the option the same way in every run that reaches it, e.g. "req-1#1@2" or "crash_after". */
  readonly label: string;
  /** For a turn: the invocation it continues and the target of the effect it performs. */
  readonly invocation?: string;
  readonly target?: string;
}

/**
 * Makes a run's choices instead of the seed: which fault (or none) at an
 * effect point, and which turn next in a concurrent run. Exhaustive
 * exploration drives runs through one of these.
 */
export interface Chooser {
  choose(kind: "fault" | "turn", options: readonly ChoiceOption[]): number;
}

export interface RunOptions {
  readonly mode: "explore" | "replay";
  readonly schedule: Schedule;
  readonly bounds: Bounds;
  readonly faultProbability: number;
  /** Makes the choices (explore mode): faults and turns are picked, not drawn from the seed. */
  readonly chooser?: Chooser;
  /**
   * Explore mode: the eligible points (counted from 0) to fault, kinds drawn
   * from the seed (see `planFaults`). Without one, each eligible point takes
   * a fault with probability `faultProbability`.
   */
  readonly faultPlan?: readonly number[];
}

class InvocationState implements Invocation {
  readonly crashed: Promise<void>;
  private readonly onCrash: () => void;
  /** Effect points seen so far in this invocation; the next effect's ordinal. */
  ordinal = 0;
  /** Times this invocation has parked for a turn; names its next turn the same in every run. */
  parks = 0;
  private crashedFlag = false;
  private resolveCrashed: () => void = () => {};
  readonly id: string;

  constructor(id: string, onCrash: () => void) {
    this.id = id;
    this.onCrash = onCrash;
    this.crashed = new Promise<void>((resolve) => {
      this.resolveCrashed = resolve;
    });
  }

  isCrashed(): boolean {
    return this.crashedFlag;
  }

  crash(): void {
    if (this.crashedFlag) return;
    this.crashedFlag = true;
    this.onCrash();
    this.resolveCrashed();
  }
}

/** The invocation a delivery started, set when it starts it; carried by the delivery's async context. */
interface DeliveryCell {
  id: string | null;
}

const deliveryScope = asyncScope<DeliveryCell>();

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

/** Delivered invocations are `<event>#<attempt>`, so this id is never one of theirs. */
const bookkeepingId = "platform";

export class Run implements RunHooks {
  private logState: EffectLog = emptyLog;
  private readonly faults: FaultDecision[] = [];
  private effectIndex = 0;
  private eligibleSeen = 0;
  private prng: PrngState;
  private readonly invocations = new Map<string, InvocationState>();
  private readonly reasons: string[] = [];
  private readonly frames = new Frames();
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

  readonly options: RunOptions;

  constructor(options: RunOptions) {
    this.options = options;
    this.prng = seedPrng(options.schedule.seed);
    this.turns = new Turns(
      options,
      this.frames,
      (id) => this.runAs(id),
      () => this.patched?.reads,
    );
    this.concurrent = options.bounds.maxConcurrentInvocations > 1;
  }

  get log(): EffectLog {
    return this.logState;
  }

  /** The schedule as actually executed: input decisions during replay, drawn ones during exploration. */
  get schedule(): Schedule {
    const recorded =
      this.options.chooser !== undefined || this.options.schedule.turns !== undefined;
    return {
      seed: this.options.schedule.seed,
      faults: [...this.faults],
      ...(recorded ? { turns: [...this.turns.picks] } : {}),
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
      this.patched = patchGlobals(this.options.schedule.seed, {
        // Web Crypto is real work the handler waits on: the run waits for it like an effect's I/O.
        trackIo: (work) => {
          this.frames.inFlight++;
          return work.finally(() => {
            this.frames.inFlight--;
            if (this.concurrent) this.progressed();
          });
        },
      });
      if (this.concurrent) {
        const clock = this.patched.clock;
        clock.ownerNow = () => this.running();
        // A timer's callback, and everything it goes on to run, belongs to the delivery that set it.
        clock.bind = (callback) => {
          const cell = deliveryScope?.getStore();
          if (!cell || !deliveryScope) return callback;
          const scope = deliveryScope;
          return (...args) => scope.run(cell, () => callback(...args));
        };
      }
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
    this.restoreFetch?.();
    this.restoreFetch = null;
    this.patched?.restore();
    this.patched = null;
  }

  /** Virtual milliseconds since the epoch, or the real clock when the globals are not installed. */
  now(): number {
    return this.patched ? this.patched.clock.now() : Date.now();
  }

  /** Timers scheduled and not yet fired or cancelled (0 when the globals are not installed). */
  pendingTimers(): number {
    return this.patched?.clock.pendingTimers() ?? 0;
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
    if (!this.concurrent) return this.current;
    return deliveryScope?.getStore()?.id ?? this.current;
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
    const inv = new InvocationState(id, () => this.patched?.clock.cancelOwner(id));
    this.invocations.set(id, inv);
    return inv;
  }

  private invocation(id: string): InvocationState {
    const inv = this.invocations.get(id);
    if (!inv) throw new Error(`effect from unknown invocation ${id}`);
    return inv;
  }

  /** Effect points so far that could take a fault (see `RunOptions.faultPlan`). */
  get eligiblePoints(): number {
    return this.eligibleSeen;
  }

  private decide(point: EffectPoint, ordinal: number): FaultKind | null {
    const position = point.allowed.length > 0 ? this.eligibleSeen++ : -1;
    const plan = this.options.faultPlan;
    if (plan && this.options.mode === "explore" && !this.options.chooser) {
      if (position < 0 || this.faults.length >= this.options.bounds.maxFaultsPerRun) return null;
      if (!plan.includes(position)) return null;
      const [i, next] = nextInt(this.prng, point.allowed.length);
      this.prng = next;
      return point.allowed[i] ?? null;
    }
    const chooser = this.options.chooser;
    if (chooser && this.options.mode === "explore") {
      if (point.allowed.length === 0 || this.faults.length >= this.options.bounds.maxFaultsPerRun)
        return null;
      const i = chooser.choose("fault", [
        { label: "none" },
        ...point.allowed.map((f) => ({ label: f })),
      ]);
      return i === 0 ? null : (point.allowed[i - 1] ?? null);
    }
    if (this.options.mode === "replay") {
      const d = this.options.schedule.faults.find(
        (f) => f.invocation === point.invocation && f.ordinal === ordinal,
      );
      return d && point.allowed.includes(d.fault) ? d.fault : null;
    }
    const [fault, next] = decideFault(this.prng, point.allowed, this.faults.length, {
      maxFaultsPerRun: this.options.bounds.maxFaultsPerRun,
      faultProbability: this.options.faultProbability,
    });
    this.prng = next;
    return fault;
  }

  private record(point: EffectPoint, kind: "call" | "result" | "fault", payload: JsonValue): void {
    if (kind === "result") this.turns.performed(point.target);
    this.logState = appendEffect(this.logState, {
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
    const inv = this.invocation(point.invocation);
    if (inv.isCrashed()) return hang();
    // An effect made inside another's perform (an object calling out during a call) is part of
    // that effect's turn: parking it would wait for the outer one, which waits for it.
    const enclosing = this.frames.enclosing(point.invocation);
    const nested = enclosing !== undefined;
    if (this.concurrent && !nested) {
      await new Promise<void>((go) => this.turns.park(inv, point.target, go));
      if (inv.isCrashed()) return hang();
    } else if (this.concurrent && enclosing?.hosts && enclosing.mayPark()) {
      // Hosted code calling out (an object's fetch during a call) is a turn too: the object's
      // input gate is open meanwhile, so another call into it may run first. While all such
      // effects of the host are parked the host is waiting, not performing I/O.
      const host = enclosing;
      let released = false;
      this.frames.adjust(host, () => {
        host.children++;
        host.waitingChildren++;
      });
      this.turns.park(inv, point.target, () => (released = true), host);
      // Wait by polling a flag with real zero timers made here, inside the hosted code: no
      // promise is settled from outside it (workerd refuses that for a Durable Object), and no
      // event has to enter it (its input gate may be closed, as in blockConcurrencyWhile).
      while (!released && !inv.isCrashed()) await realTick();
      if (!released) {
        this.frames.adjust(host, () => {
          host.children--;
          host.waitingChildren--;
        });
        return hang();
      }
      try {
        return await this.performEffect(point, perform, summarize, options, inv, enclosing, host);
      } finally {
        this.frames.adjust(host, () => host.children--);
      }
    }
    return this.performEffect(point, perform, summarize, options, inv, enclosing);
  }

  /** The effect once it has its turn: the fault, the perform under its deadline, the record. */
  private async performEffect<T>(
    point: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
    options: EffectOptions,
    inv: InvocationState,
    enclosing: Frame | undefined,
    /** The hosting effect this one waited for a turn under, which waits on it while it waits. */
    host?: Frame,
  ): Promise<T> {
    // A crash hangs this effect; inside another effect's perform it ends that effect too.
    const dead = (): Promise<T> => {
      enclosing?.crash();
      return hang();
    };
    const fault = this.open(point, inv);
    if (fault === "crash_before" || fault === "cut_off") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      return dead();
    }
    if (fault === "error") {
      this.record(point, "fault", { args: point.args, fault });
      throw new InjectedEffectError(point, fault);
    }
    let settled:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }
      | "expired"
      | "nested_crash";
    // Real I/O that outlasts the scenario's whole budget is treated as hung, so the run ends.
    const deadline = realDeadline(this.options.bounds.budgetMs);
    const frame = new Frame(point.invocation, point.hostsEffects === true, options);
    frame.parent = host;
    this.frames.enter(frame);
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
      deadline.cancel();
      this.frames.leave(frame);
      this.patched?.clock.advance(effectLatencyMs);
      if (this.concurrent) this.progressed();
    }
    if (settled === "expired") {
      this.unsupported(
        `${point.target} ${point.op} did not complete within ${this.options.bounds.budgetMs} ms of real time`,
      );
      inv.crash();
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
    // The effect committed while the invocation was dying: nothing after it runs.
    if (inv.isCrashed()) return hang();
    if (fault === "crash_after") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      return dead();
    }
    if (fault === "ambiguous") {
      this.record(point, "fault", { args: point.args, fault });
      throw new InjectedEffectError(point, fault);
    }
    return value;
  }

  effectSync<T>(point: EffectPoint, perform: () => T, summarize: (value: T) => JsonValue): T {
    const inv = this.invocation(point.invocation);
    if (inv.isCrashed()) throw new CrashSignal(inv.id);
    const fault = this.open(point, inv);
    if (fault === "crash_before" || fault === "cut_off") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      throw new CrashSignal(inv.id);
    }
    if (fault === "error") {
      this.record(point, "fault", { args: point.args, fault });
      throw new InjectedEffectError(point, fault);
    }
    let value: T;
    try {
      value = perform();
    } catch (err) {
      this.record(point, "result", { args: point.args, result: null, error: String(err) });
      throw err;
    }
    this.record(point, "result", { args: point.args, result: summarize(value) });
    if (fault === "crash_after") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      throw new CrashSignal(inv.id);
    }
    if (fault === "ambiguous") {
      this.record(point, "fault", { args: point.args, fault });
      throw new InjectedEffectError(point, fault);
    }
    return value;
  }

  unsupported(reason: string): void {
    this.reasons.push(reason);
  }

  settle<T>(promise: Promise<T>, invocation: string): Promise<T> {
    const inv = this.invocation(invocation);
    // In a concurrent run the run itself fires timers and detects a stuck run (see `quiesce`).
    if (this.concurrent) return Promise.race([promise, inv.crashed.then(() => hang<T>())]);
    const patched = this.patched;
    if (patched) patched.clock.owner = invocation;
    this.current = invocation;
    if (!patched) {
      // Globals not installed (direct use outside runOnce): just wait, abandoning on crash.
      return Promise.race([promise, inv.crashed.then(() => hang<T>())]);
    }
    return settleOn(promise, {
      clock: patched.clock,
      inFlight: () => this.frames.inFlight,
      crashed: () => inv.isCrashed(),
      stuck: () => {
        // Nothing can make progress: report it and abandon the invocation so the run can end.
        this.unsupported(waitingUnseen(invocation));
        inv.crash();
      },
    });
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
    return this.turns.quiesce();
  }

  /**
   * Concurrent runs: pick the next turn among the parked invocations and,
   * when `canStart`, starting the next event. Parked invocations are ordered
   * by start, then by when they parked, so the pick does not depend on
   * real-time arrival. Returns what was picked; "turn" has already released it.
   */
  takeTurn(canStart: boolean): "turn" | "start" | "none" {
    return this.turns.takeTurn(canStart);
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
    for (let due = clock.nextDue(); due !== undefined && due <= at; due = clock.nextDue()) {
      this.fireNextTimer(clock);
      fired = true;
      // What the timer set off runs at its own time, before the clock moves on.
      do await eventLoopTurn();
      while (this.frames.inFlight > 0);
    }
    clock.advance(at - clock.now());
    return fired;
  }

  /** When the next virtual timer is due, or undefined when none is pending. */
  nextTimerDue(): number | undefined {
    return this.patched?.clock.nextDue();
  }

  /** Concurrent runs: fire the next due timer as the invocation that set it. False when none is pending. */
  fireTimer(): boolean {
    const clock = this.patched?.clock;
    if (!clock || clock.nextOwner() === undefined) return false;
    return this.fireNextTimer(clock);
  }

  /** Fire the next due timer as the invocation that set it (a step of a concurrent run). */
  private fireNextTimer(clock: VirtualClock): boolean {
    this.runAs(clock.nextOwner() ?? null);
    if (this.concurrent) this.turns.step();
    return clock.fireNext();
  }

  /**
   * Concurrent runs: nothing can make progress; abandon these invocations so
   * the run can end. Returns how many were still alive.
   */
  abandon(ids: readonly string[]): number {
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

  /** A call of a pure core function, recorded as a decision of the invocation running now (see `observeCore`). */
  decision(fn: string, payload: JsonValue): void {
    this.logState = appendEffect(this.logState, {
      kind: "result",
      invocation: this.running(),
      target: decisionTarget(fn),
      op: "decide",
      payload,
    });
  }

  snapshot(invocation: string, target: string, payload: JsonValue): void {
    this.logState = appendEffect(this.logState, {
      kind: "snapshot",
      invocation,
      target,
      op: "snapshot",
      payload,
    });
  }
}
