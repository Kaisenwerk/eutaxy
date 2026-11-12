/**
 * Effects being performed, and what is in flight. An effect made inside
 * another's perform (an object calling out during a call) is nested in it;
 * a hosting effect (`hostsEffects`) runs user code that makes effects of its
 * own. The in-flight count is what the settle loop and the concurrent
 * scheduler wait on: real I/O pending, minus hosting effects that are only
 * waiting on parked effects of their own.
 */

import type { EffectOptions, EffectPoint } from "@eutaxy/core";
import { asyncScope } from "./context.ts";

/**
 * An effect being performed. An effect made inside it is nested in it; when
 * a crash is injected there, the nested effect hangs like any crashed
 * effect and tells this frame, so the enclosing effect ends too. User code
 * never sees the crash as an error it could catch.
 */
export class Frame {
  /** The invocation whose effect this is. */
  readonly invocation: string;
  readonly target: string;
  readonly op: string;
  /** Whether the effect hosts user code that makes effects of its own (`hostsEffects`). */
  readonly hosts: boolean;
  /** Whose code the effect hosts, when it stays alive after the effect (`EffectOptions.host`). */
  readonly host: string | undefined;
  /** False once the effect's perform has ended. */
  active = true;
  /** The effect's `onAbandon`, called where the crash happens (inside the hosted code's context). */
  private readonly onAbandon: (() => void) | undefined;
  /** Set by the run: told, after `onAbandon` reset the host, which host it was. */
  onHostAbandoned: ((host: string) => void) | undefined;
  /** The effect's `mayPark`: whether an effect its hosted code makes may wait for a turn now. */
  readonly mayPark: () => boolean;
  /** The hosting effect this one was made inside of and waited for a turn under, if any. */
  parent: Frame | undefined;
  /** Effects the hosted code made that are parked or running now. */
  children = 0;
  /** Effects nested in this one (made inside its perform, not as turns) being performed now. */
  performing = 0;
  /** A host's effect whose call the host's code has started (`Frames.claimHost`). */
  claimed = false;
  /** The host's code this effect is the call of has started running (`Run.hostedCode`); until then the call is in transit. */
  entered = false;
  /** Code the host runs on the call's way in (`Run.hostEntering`: its constructor's) is running now, this many times over. */
  entering = 0;
  /** The host's code this effect is the call of has returned (`Frames.answered`): its answer is in transit. */
  answered = false;
  /**
   * The attempt (`RunHooks.attempt`) whose code made this effect, if any: what
   * the effect hosts is that attempt's code too, late once the attempt is.
   */
  attempt: { readonly late: boolean } | undefined;
  /** Of those, the ones parked, or running but only waiting on parked effects of their own. */
  waitingChildren = 0;
  private abandoned = false;
  private wake: () => void = () => {};
  readonly crashed = new Promise<"nested_crash">((resolve) => {
    this.wake = () => resolve("nested_crash");
  });
  constructor(
    point: Pick<EffectPoint, "invocation" | "target" | "op" | "hostsEffects">,
    options: EffectOptions,
  ) {
    this.invocation = point.invocation;
    this.target = point.target;
    this.op = point.op;
    this.hosts = point.hostsEffects === true;
    this.host = options.host;
    this.onAbandon = options.onAbandon;
    this.mayPark = options.mayPark ?? (() => true);
  }

  /** Its hosted code is only waiting on effects of its own that are parked (however deep). */
  isWaiting(): boolean {
    return this.children > 0 && this.waitingChildren === this.children;
  }

  /**
   * Whether it counts as real I/O pending: unless its hosted code is only
   * waiting on parked effects of its own; once that code has answered, the
   * answer is on its way whatever it left parked, so the effect counts again
   * until it ends.
   */
  inFlight(): boolean {
    return this.answered || !this.isWaiting();
  }

  crash(): void {
    this.wake();
    this.abandon();
  }

  /** Whether the effect was abandoned: a crash in its hosted code, or its I/O past the budget; the host was reset. */
  get isAbandoned(): boolean {
    return this.abandoned;
  }

  /**
   * The run's bookkeeping first, the platform's reset last: a Durable
   * Object's `abort()` tears down the task it is called in, so nothing after
   * it may be counted on to run.
   */
  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    if (this.host !== undefined) this.onHostAbandoned?.(this.host);
    this.onAbandon?.();
  }
}

/** The frame of the effect whose `perform` the current code runs inside. */
export const effectScope = asyncScope<Frame>();

/** One run's frames and in-flight count. */
export class Frames {
  /** Real I/O pending: effects being performed and tracked work, less hosting effects only waiting. */
  inFlight = 0;
  /** Effects being performed, innermost last (the nesting test where there is no async context). */
  private readonly stack: Frame[] = [];
  /** Per invocation, its effects with `hostsEffects` being performed, innermost last. */
  private readonly hosting = new Map<string, Frame[]>();
  /** Effects with `hostsEffects` being performed now, across invocations. */
  private hostingCount = 0;
  /** Per host (`EffectOptions.host`), its effects being performed, innermost last. */
  private readonly byHost = new Map<string, Frame[]>();

  /** How many effects with `hostsEffects` are being performed now: above 0, hosted code may be running. */
  get hostingNow(): number {
    return this.hostingCount;
  }

  /** The innermost effect of `host`'s being performed now, if any: code of the host's runs inside it. */
  liveHost(host: string): Frame | undefined {
    return this.byHost.get(host)?.at(-1);
  }

  /** The effects of `invocation`'s being performed now that host an object's code (`EffectOptions.host`). */
  hostingOf(invocation: string): Frame[] {
    return this.stack.filter((f) => f.invocation === invocation && f.host !== undefined);
  }

  /**
   * The oldest effect of `host`'s being performed, with `op` when given, whose
   * call the host's code has not started yet, now claimed: an object's input
   * gate delivers calls in the order they arrived, which is the order their
   * effects entered. Without one of that op, the oldest unclaimed of any.
   */
  /**
   * The effect of `host`'s being performed whose call is on its way in: the
   * oldest the host's code has not started, else the newest of its effects.
   * Not claimed: the call's own code claims it when it starts.
   */
  enteringHost(host: string): Frame | undefined {
    const live = this.byHost.get(host) ?? [];
    return live.find((f) => !f.claimed) ?? live.at(-1);
  }

  claimHost(host: string, op?: string): Frame | undefined {
    const live = this.byHost.get(host) ?? [];
    const frame =
      (op === undefined ? undefined : live.find((f) => !f.claimed && f.op === op)) ??
      live.find((f) => !f.claimed);
    if (frame) frame.claimed = true;
    return frame;
  }

  /**
   * The hosts of the effects in flight, when every one of them is a hosting
   * effect whose hosted code is idle: running (entered, its answer not yet
   * on its way), with no effect of it performing or waiting for a turn,
   * nothing hosted inside it and no real work tracked. Such code can only
   * be awaiting a timer of its own (an object sleeping before it answers),
   * which the run may fire for it. Null while anything else is in flight,
   * or nothing is: a call still crossing into its object is on its way, and
   * waiting for it keeps the order in which calls enter the object the
   * schedule's, not real time's (two timers due together fire by the order
   * they were set).
   */
  idleHosts(): Set<string> | null {
    let counted = 0;
    const hosts = new Set<string>();
    for (const frame of this.stack) {
      if (frame.isWaiting()) continue;
      counted++;
      if (
        frame.host === undefined ||
        // Not yet in the host's code, unless the host is running code on the call's way in.
        !(frame.entered || frame.entering > 0) ||
        frame.answered ||
        frame.performing > 0 ||
        frame.children > 0
      )
        return null;
      hosts.add(frame.host);
    }
    return counted > 0 && counted === this.inFlight ? hosts : null;
  }

  /**
   * The effect an invocation's new effect is made inside of, if any. Async
   * context tells exactly which code is inside; an invocation merely woken
   * meanwhile is not. A hosting effect's own effects are attributed to its
   * invocation: only those count as nested. Async context can be stale (code
   * resumed in the context of an effect that has ended, as an object's code
   * may run in the context it was built in) or absent (workerd carries none
   * into an object's code): trust only a live frame of the same invocation
   * (the innermost); else, for code in a stale context or hosted code
   * (`hosted`: an object's, entered by the platform), the invocation's own
   * hosting effect. Code in no context at all that is not hosted is
   * outside every effect: a second strand of the invocation (a step
   * attempt the engine gave up on, see `Run.attempt`) running while a call
   * of the first strand is in flight.
   */
  enclosing(invocation: string, hosted = true): Frame | undefined {
    if (!effectScope) return this.stack.at(-1);
    const store = effectScope.getStore();
    if (store?.active && store.invocation === invocation) return store;
    return hosted || store !== undefined ? this.hosting.get(invocation)?.at(-1) : undefined;
  }

  /**
   * The effect whose perform the current code runs inside, whatever
   * invocation it belongs to: the live frame of the async context, else the
   * innermost being performed. Where another invocation's code is hosted.
   */
  current(): Frame | undefined {
    if (!effectScope) return this.stack.at(-1);
    const store = effectScope.getStore();
    return store?.active ? store : undefined;
  }

  /** An effect starts being performed: it is in flight. */
  enter(frame: Frame): void {
    this.inFlight++;
    this.stack.push(frame);
    if (frame.hosts) {
      this.hostingFrames(frame.invocation).push(frame);
      this.hostingCount++;
    }
    if (frame.host !== undefined) {
      const frames = this.byHost.get(frame.host) ?? [];
      frames.push(frame);
      this.byHost.set(frame.host, frames);
    }
  }

  /**
   * The host's code `frame` is the call of has returned: its answer is in
   * transit, so the effect is in flight until it ends, whatever that code
   * left parked (the run waits for the answer before its next turn, so what
   * the code left outstanding is handed over before anything else moves).
   */
  answered(frame: Frame): void {
    if (frame.answered) return;
    const before = frame.inFlight();
    frame.answered = true;
    if (frame.active && !before) this.inFlight++;
  }

  /** An effect's perform has ended. */
  leave(frame: Frame): void {
    if (frame.hosts) {
      const hosted = this.hostingFrames(frame.invocation);
      hosted.splice(hosted.lastIndexOf(frame), 1);
      this.hostingCount--;
    }
    this.stack.splice(this.stack.lastIndexOf(frame), 1);
    if (frame.host !== undefined) {
      const frames = this.byHost.get(frame.host);
      frames?.splice(frames.lastIndexOf(frame), 1);
    }
    // A frame only waiting on parked effects already counts as not in flight, and as waiting for
    // its parent: undo both as it ends.
    if (frame.inFlight()) this.inFlight--;
    if (frame.isWaiting() && frame.parent) {
      const parent = frame.parent;
      this.adjust(parent, () => parent.waitingChildren--);
    }
    frame.active = false;
    frame.parent = undefined;
  }

  /**
   * Change a hosting frame's children and keep `inFlight` in step: a frame
   * counts in flight unless it is only waiting on parked effects of its own,
   * and a frame that starts or stops waiting does so for its parent too.
   */
  adjust(frame: Frame, change: () => void): void {
    const waitingBefore = frame.isWaiting();
    const inFlightBefore = frame.inFlight();
    change();
    const waiting = frame.isWaiting();
    if (frame.active && inFlightBefore !== frame.inFlight()) this.inFlight += waiting ? -1 : 1;
    if (waitingBefore === waiting) return;
    const parent = frame.parent;
    if (frame.active && parent)
      this.adjust(parent, () => (parent.waitingChildren += waiting ? 1 : -1));
  }

  private hostingFrames(invocation: string): Frame[] {
    let frames = this.hosting.get(invocation);
    if (!frames) {
      frames = [];
      this.hosting.set(invocation, frames);
    }
    return frames;
  }
}
