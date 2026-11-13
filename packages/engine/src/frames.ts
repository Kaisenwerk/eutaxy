/**
 * Effects being performed, and what is in flight. An effect made inside
 * another's perform (an object calling out during a call) is nested in it;
 * a hosting effect (`hostsEffects`) runs user code that makes effects of its
 * own. The in-flight count is what the settle loop and the concurrent
 * scheduler wait on: real I/O pending, minus hosting effects whose code is
 * only waiting on effects of its own, each of which is parked or counted
 * itself. The rule is the same at every depth: an object's call nested in
 * another object's call is counted as a call from the Worker is.
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
  /** Effects the hosted code made as turns, parked or running now, and invocations hosted inside it. */
  children = 0;
  /** Of those, the ones given their turn that have not started performing yet: on their way. */
  arriving = 0;
  /** Effects made inside this one's perform being performed now, its children that run included. */
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
  /**
   * The host whose code made this effect, when a host's did. What awaits
   * the effect runs in that host's context and goes with it when the host
   * is reset (the runtime tears the context down), so the run ends the
   * effect itself then (`Run.hostAbandoned`).
   */
  issuer: string | undefined;
  /**
   * Its issuer was reset while the code it hosts was running: that code
   * goes on in its own object, so the effect stays until the code answers
   * or crashes, and is ended there.
   */
  orphaned = false;
  /**
   * The instance of its host whose code this call entered was reset: that
   * code is gone and will not answer, whatever it left outstanding died
   * with it, and nothing of it is the new instance's work.
   */
  codeGone = false;
  /** End the effect's bookkeeping; set by the run, and safe to call again. */
  end: () => void = () => {};
  /** Stop the deadline its perform is awaited under; set by the run, which times an orphan itself. */
  untime: () => void = () => {};
  private abandoned = false;
  private struck = false;
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

  /**
   * Its hosted code is only waiting on effects of its own, and each of
   * those is accounted for: parked for a turn, or being performed and so
   * counted itself (a call into another object the code awaits, whose own
   * code may be idle, waiting or busy in its turn). One given its turn and
   * not yet performing is on its way, so the code is not covered then. A
   * call into a host (an object) is covered only once its code is running
   * there: one whose constructor left an effect parked and whose method has
   * not started is still on its way in, and taking it for covered would let
   * another call enter the host's code ahead of it. Only an effect that
   * hosts code is ever covered: another effect's own perform is real I/O
   * whatever it makes meanwhile.
   */
  isCovered(): boolean {
    const inside = this.host === undefined || this.entered || this.entering > 0;
    const outstanding = this.children > 0 || (this.hosts && this.performing > 0);
    // Code that went with its instance covers nothing: what it left counted will never be
    // uncounted by it, and the call is the runtime's to fail and its caller's to end.
    return inside && outstanding && this.arriving === 0 && !this.codeGone;
  }

  /**
   * Whether it counts as real I/O pending: unless its hosted code is covered;
   * once that code has answered, the answer is on its way whatever it left
   * outstanding, so the effect counts again until it ends.
   */
  inFlight(): boolean {
    return this.answered || !this.isCovered();
  }

  /**
   * Whether a crash inside it was signalled (`crash`). Read after the
   * perform settles, not only raced against it: the signal is raised where
   * the crash happened, which may be another object's context, and what
   * then wakes the code awaiting the effect may be the runtime's own
   * rejection of a call into the object the crash reset.
   */
  get wasCrashed(): boolean {
    return this.struck;
  }

  crash(): void {
    this.struck = true;
    this.wake();
    this.abandon();
    // Nothing is left awake to end it.
    if (this.orphaned) this.end();
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

  /** The effects being performed now that are calls into `host`, oldest first. */
  into(host: string): Frame[] {
    return [...(this.byHost.get(host) ?? [])];
  }

  /** The effects `host`'s code made that are being performed now, innermost first. */
  issuedBy(host: string): Frame[] {
    return this.stack.filter((f) => f.issuer === host).reverse();
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
   * which the run may fire for it. An effect whose code is covered (an
   * object awaiting its call into another) is not in flight and has no say:
   * what it awaits is judged in its own right, so the object asleep at the
   * end of a chain of calls is found however long the chain. Null while
   * anything else is in flight, or nothing is: a call still crossing into
   * its object is on its way, and waiting for it keeps the order in which
   * calls enter the object the schedule's, not real time's (two timers due
   * together fire by the order they were set).
   */
  idleHosts(): Set<string> | null {
    let counted = 0;
    const hosts = new Set<string>();
    for (const frame of this.stack) {
      if (!frame.inFlight()) continue;
      counted++;
      if (
        frame.host === undefined ||
        // Not yet in the host's code, unless the host is running code on the call's way in.
        !(frame.entered || frame.entering > 0) ||
        frame.answered ||
        // Not idle code: the instance it ran in is gone, and the runtime is failing the call.
        frame.codeGone ||
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
   * (the innermost); else, for hosted code (`hosted`: an object's, entered
   * by the platform), the call that code is (`call`, when the platform
   * knows it: an invocation may have calls into several objects in flight
   * at once, and the one that started last is not the one every object's
   * code is inside); else, for hosted code or code in a stale context, the
   * invocation's own innermost hosting effect. Code in no context at all that is not hosted is
   * outside every effect: a second strand of the invocation (a step
   * attempt the engine gave up on, see `Run.attempt`) running while a call
   * of the first strand is in flight.
   */
  enclosing(invocation: string, hosted = true, call?: Frame): Frame | undefined {
    if (!effectScope) return this.stack.at(-1);
    const store = effectScope.getStore();
    if (store?.active && store.invocation === invocation) return store;
    if (call?.active && call.invocation === invocation) return call;
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
    // A covered frame already counts as not in flight.
    if (frame.inFlight()) this.inFlight--;
    frame.active = false;
    frame.parent = undefined;
  }

  /**
   * Change what a frame's hosted code has outstanding (or where its call
   * is) and keep `inFlight` in step: a frame counts in flight unless its
   * code is covered.
   */
  adjust(frame: Frame, change: () => void): void {
    const before = frame.inFlight();
    change();
    const now = frame.inFlight();
    if (frame.active && before !== now) this.inFlight += now ? 1 : -1;
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
