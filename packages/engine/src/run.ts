/**
 * One run of a scenario: the effect log being built, the fault decisions
 * (drawn during exploration, looked up during replay), and the invocations
 * in flight. Proxies in the platform package call `effect`/`effectSync`
 * around every real effect; everything else is engine-internal.
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
  type PrngState,
  type RunHooks,
  type Schedule,
  seedPrng,
} from "@eutaxy/core";
import { effectLatencyMs, type Patched, patchGlobals, settleOn } from "./clock.ts";
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

  readonly options: RunOptions;

  constructor(options: RunOptions) {
    this.options = options;
    this.prng = seedPrng(options.schedule.seed);
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
    if (!this.patched) this.patched = patchGlobals(this.options.schedule.seed);
    if (!this.restoreFetch) {
      this.restoreFetch = installScriptedFetch(
        externals,
        { hooks: this, invocation: () => this.current },
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
    if (this.patched) this.patched.clock.owner = id;
    this.current = id;
    return inv;
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
