/**
 * One run of a scenario: the effect log being built, the fault decisions
 * (drawn during exploration, looked up during replay), and the invocations
 * in flight. Proxies in the platform package call `effect`/`effectSync`
 * around every real effect; everything else is engine-internal.
 *
 * With `maxConcurrentInvocations` above 1 the run is concurrent: several
 * invocations are in flight. Each asynchronous effect is a turn: the
 * invocation parks there, and once every invocation has parked, finished or
 * gone idle the run picks which parked one goes next (or whether a new event
 * starts) from a stream seeded by the schedule's seed. Exploration and
 * replay make the same picks, so the schedule needs no record of them. Each
 * delivery runs in its own async context, so an effect is attributed to the
 * invocation whose code made it even when a promise shared between
 * invocations resumes one during another's turn.
 */

import {
  appendEffect,
  type Bounds,
  decideFault,
  type EffectLog,
  type EffectPoint,
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
import { effectLatencyMs, type Patched, patchGlobals, realTick, settleOn } from "./clock.ts";
import { asyncScope } from "./context.ts";
import { installScriptedFetch } from "./fetch.ts";

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
  readonly mode: "explore" | "replay";
  readonly schedule: Schedule;
  readonly bounds: Bounds;
  readonly faultProbability: number;
}

class InvocationState implements Invocation {
  readonly crashed: Promise<void>;
  private readonly onCrash: () => void;
  /** Effect points seen so far in this invocation; the next effect's ordinal. */
  ordinal = 0;
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

export class Run implements RunHooks {
  private logState: EffectLog = emptyLog;
  private readonly faults: FaultDecision[] = [];
  private effectIndex = 0;
  private prng: PrngState;
  private readonly invocations = new Map<string, InvocationState>();
  private readonly reasons: string[] = [];
  private inFlight = 0;
  private patched: Patched | null = null;
  private restoreFetch: (() => void) | null = null;
  /** The invocation whose code is running (one at a time); outbound fetches are attributed to it. */
  private current = "";
  /** Concurrent runs only: invocations waiting at an effect for their turn. */
  private parked: {
    readonly inv: InvocationState;
    readonly seq: number;
    readonly go: () => void;
  }[] = [];
  private parkSeq = 0;
  /** Concurrent runs only: the order invocations started in, which orders the parked ones. */
  private readonly startOrder = new Map<string, number>();
  /** Concurrent runs only: the picks among parked invocations, drawn apart from fault decisions. */
  private turns: PrngState;

  /** Whether several invocations may be in flight (`maxConcurrentInvocations` above 1). */
  readonly concurrent: boolean;

  readonly options: RunOptions;

  constructor(options: RunOptions) {
    this.options = options;
    this.prng = seedPrng(options.schedule.seed);
    this.turns = seedPrng(`turns:${options.schedule.seed}`);
    this.concurrent = options.bounds.maxConcurrentInvocations > 1;
  }

  get log(): EffectLog {
    return this.logState;
  }

  /** The schedule as actually executed: input decisions during replay, drawn ones during exploration. */
  get schedule(): Schedule {
    return { seed: this.options.schedule.seed, faults: [...this.faults] };
  }

  get effectPoints(): number {
    return this.effectIndex;
  }

  get faultsInjected(): number {
    return this.faults.length;
  }

  get unsupportedReasons(): readonly string[] {
    return this.reasons;
  }

  /** Replace the nondeterministic globals and `fetch` for this run. Call `uninstall` in a finally. */
  install(externals: readonly ExternalDecl[] = []): void {
    if (!this.patched) {
      this.patched = patchGlobals(this.options.schedule.seed);
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

  startInvocation(id: string): Invocation {
    if (this.invocations.has(id)) throw new Error(`invocation ${id} already started`);
    const inv = new InvocationState(id, () => this.patched?.clock.cancelOwner(id));
    this.invocations.set(id, inv);
    if (this.concurrent) {
      this.startOrder.set(id, this.startOrder.size);
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

  running(): string {
    if (!this.concurrent) return this.current;
    return deliveryScope?.getStore()?.id ?? this.current;
  }

  private runAs(id: string | null): void {
    if (this.patched) this.patched.clock.owner = id;
    if (id !== null) this.current = id;
  }

  private invocation(id: string): InvocationState {
    const inv = this.invocations.get(id);
    if (!inv) throw new Error(`effect from unknown invocation ${id}`);
    return inv;
  }

  private decide(point: EffectPoint, ordinal: number): FaultKind | null {
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
  ): Promise<T> {
    const inv = this.invocation(point.invocation);
    if (inv.isCrashed()) return hang();
    if (this.concurrent) {
      await new Promise<void>((go) => this.parked.push({ inv, seq: this.parkSeq++, go }));
      if (inv.isCrashed()) return hang();
    }
    const fault = this.open(point, inv);
    if (fault === "crash_before" || fault === "cut_off") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      return hang();
    }
    if (fault === "error") {
      this.record(point, "fault", { args: point.args, fault });
      throw new InjectedEffectError(point, fault);
    }
    let value: T;
    this.inFlight++;
    try {
      // The library's own timers inside the I/O are real; the handler's stay virtual.
      value = await (this.patched ? this.patched.libraryIo(perform) : perform());
    } catch (err) {
      this.record(point, "result", { args: point.args, result: null, error: String(err) });
      throw err;
    } finally {
      this.inFlight--;
      this.patched?.clock.advance(effectLatencyMs);
    }
    this.record(point, "result", { args: point.args, result: summarize(value) });
    // The effect committed while the invocation was dying: nothing after it runs.
    if (inv.isCrashed()) return hang();
    if (fault === "crash_after") {
      this.record(point, "fault", { args: point.args, fault });
      inv.crash();
      return hang();
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
      return Promise.race([promise, inv.crashed.then(() => new Promise<T>(() => {}))]);
    }
    return settleOn(promise, {
      clock: patched.clock,
      inFlight: () => this.inFlight,
      crashed: () => inv.isCrashed(),
      stuck: () => {
        // Nothing can make progress: report it and abandon the invocation so the run can end.
        this.unsupported(
          `invocation ${invocation} is waiting on something Eutaxy cannot see (no effect in flight, no timer due)`,
        );
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

  /**
   * Concurrent runs: wait until the running invocation has parked, finished
   * or gone idle, that is, no effect is performing real I/O after a turn of
   * the real event loop.
   */
  async quiesce(): Promise<void> {
    do await realTick();
    while (this.inFlight > 0);
  }

  /**
   * Concurrent runs: pick the next turn among the parked invocations and,
   * when `canStart`, starting the next event. Parked invocations are ordered
   * by start, then by when they parked, so the pick does not depend on
   * real-time arrival. Returns what was picked; "turn" has already released it.
   */
  takeTurn(canStart: boolean): "turn" | "start" | "none" {
    const order = (inv: InvocationState) => this.startOrder.get(inv.id) ?? 0;
    this.parked = this.parked
      .filter((p) => !p.inv.isCrashed())
      .sort((a, b) => order(a.inv) - order(b.inv) || a.seq - b.seq);
    const options = this.parked.length + (canStart ? 1 : 0);
    if (options === 0) return "none";
    let pick = 0;
    if (options > 1) {
      const [i, next] = nextInt(this.turns, options);
      this.turns = next;
      pick = i;
    }
    const [chosen] = pick < this.parked.length ? this.parked.splice(pick, 1) : [];
    if (!chosen) return "start";
    this.runAs(chosen.inv.id);
    chosen.go();
    return "turn";
  }

  /** Concurrent runs: fire the next due timer as the invocation that set it. False when none is pending. */
  fireTimer(): boolean {
    const clock = this.patched?.clock;
    if (!clock) return false;
    const owner = clock.nextOwner();
    if (owner === undefined) return false;
    this.runAs(owner);
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
      this.unsupported(
        `invocation ${id} is waiting on something Eutaxy cannot see (no effect in flight, no timer due)`,
      );
      inv.crash();
      abandoned++;
    }
    return abandoned;
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
