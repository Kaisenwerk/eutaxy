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

  crash(): void {
    this.abandon();
    this.wake();
  }

  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.onAbandon?.();
    if (this.host !== undefined) this.onHostAbandoned?.(this.host);
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

  /**
   * The oldest effect of `host`'s being performed, with `op` when given, whose
   * call the host's code has not started yet, now claimed: an object's input
   * gate delivers calls in the order they arrived, which is the order their
   * effects entered. Without one of that op, the oldest unclaimed of any.
   */
  claimHost(host: string, op?: string): Frame | undefined {
    const live = this.byHost.get(host) ?? [];
    const frame =
      (op === undefined ? undefined : live.find((f) => !f.claimed && f.op === op)) ??
      live.find((f) => !f.claimed);
    if (frame) frame.claimed = true;
    return frame;
  }

  /**
   * The effect an invocation's new effect is made inside of, if any. Async
   * context tells exactly which code is inside; an invocation merely woken
   * meanwhile is not. A hosting effect's own effects are attributed to its
   * invocation: only those count as nested. Async context can be stale (code
   * resumed in the context of an effect that has ended, as an object's code
   * may run in the context it was built in): trust only a live frame of the
   * same invocation (the innermost), else the invocation's own hosting effect.
   */
  enclosing(invocation: string): Frame | undefined {
    const store = effectScope?.getStore();
    const live = store?.active && store.invocation === invocation ? store : undefined;
    return effectScope ? (live ?? this.hosting.get(invocation)?.at(-1)) : this.stack.at(-1);
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
    if (!frame.isWaiting()) this.inFlight--;
    else if (frame.parent) {
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
    const before = frame.isWaiting();
    change();
    const after = frame.isWaiting();
    if (before === after) return;
    if (frame.active) this.inFlight += after ? -1 : 1;
    const parent = frame.parent;
    if (frame.active && parent)
      this.adjust(parent, () => (parent.waitingChildren += after ? 1 : -1));
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
