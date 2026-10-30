/**
 * The virtual clock and the globals patch. Within a run, Date, Math.random,
 * crypto.randomUUID, crypto.getRandomValues, performance.now and the timer
 * functions are replaced by deterministic versions driven by the run's seed
 * and by a clock that starts at a fixed epoch and advances only when the
 * engine says so: one millisecond per effect, and to each timer's due time
 * when the timer fires. Timers fire only while the invocation is idle (no
 * effect in flight), in due order, so they never race real I/O.
 */

import { nextFloat, nextU32, type PrngState, seedPrng } from "@eutaxy/core";
import { asyncScope } from "./context.ts";
import { patchProperty } from "./patch.ts";

/** 2026-01-01T00:00:00.000Z. Every run starts here. */
export const virtualEpoch = Date.UTC(2026, 0, 1);

/** Virtual time advances this much at each effect completion. */
export const effectLatencyMs = 1;

// Captured before any patching, so the engine can yield to the real event loop.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

/**
 * Tells library code apart from handler code while an effect's real I/O runs.
 * SDKs back off and time out with timers, which must be real; a handler timer
 * scheduled meanwhile must stay virtual. Node's AsyncLocalStorage follows the
 * library's promise chains and I/O callbacks but not the handler's own
 * continuations. Where it is unavailable (workerd without Node compatibility)
 * every timer stays virtual; the Cloudflare bindings do not use timers.
 */
const libraryScope = asyncScope<true>();

interface Timer {
  readonly id: number;
  due: number;
  readonly callback: (...args: unknown[]) => void;
  readonly args: readonly unknown[];
  readonly interval: number | null;
  /** The invocation that scheduled it; cancelled with that invocation when it crashes. */
  readonly owner: string | null;
}

export class VirtualClock {
  private time = virtualEpoch;
  private timers: Timer[] = [];
  private nextId = 1;
  /** The invocation whose code is running; timers scheduled now belong to it. */
  owner: string | null = null;
  /** Set by a concurrent run: who is running, asked when a timer is scheduled (overrides `owner`). */
  ownerNow: (() => string | null) | null = null;
  /** Set by a concurrent run: binds a callback to the async context it was scheduled in. */
  bind: ((callback: (...args: unknown[]) => void) => (...args: unknown[]) => void) | null = null;

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    if (ms > 0) this.time += ms;
  }

  private schedule(
    callback: (...args: unknown[]) => void,
    delay: number,
    args: readonly unknown[],
    interval: number | null,
  ): number {
    const ms = Number.isFinite(delay) && delay > 0 ? Math.floor(delay) : 0;
    const timer: Timer = {
      id: this.nextId++,
      due: this.time + ms,
      callback: this.bind ? this.bind(callback) : callback,
      args,
      interval,
      owner: this.ownerNow ? this.ownerNow() : this.owner,
    };
    this.timers.push(timer);
    return timer.id;
  }

  setTimeout(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): number {
    return this.schedule(callback, delay, args, null);
  }

  setInterval(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): number {
    return this.schedule(callback, delay, args, Math.max(1, Math.floor(delay)));
  }

  clear(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** Whether this clock issued the handle (and the timer is still pending). */
  owns(id: unknown): id is number {
    return typeof id === "number" && this.timers.some((t) => t.id === id);
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Drop every timer an invocation scheduled: a crashed invocation's code must never run again. */
  cancelOwner(owner: string): void {
    this.timers = this.timers.filter((t) => t.owner !== owner);
  }

  private earliest(): Timer | undefined {
    let earliest = this.timers[0];
    for (const t of this.timers)
      if (earliest && (t.due < earliest.due || (t.due === earliest.due && t.id < earliest.id)))
        earliest = t;
    return earliest;
  }

  /** When the next timer is due, or undefined when none is pending. */
  nextDue(): number | undefined {
    return this.earliest()?.due;
  }

  /** Who set the timer `fireNext` would run: an invocation, null for none, undefined when no timer is pending. */
  nextOwner(): string | null | undefined {
    return this.earliest()?.owner;
  }

  /** Advance to the earliest due timer and run it. False when none is pending. */
  fireNext(): boolean {
    const earliest = this.earliest();
    if (!earliest) return false;
    if (earliest.due > this.time) this.time = earliest.due;
    if (earliest.interval === null) this.timers = this.timers.filter((t) => t !== earliest);
    else earliest.due = this.time + earliest.interval;
    try {
      earliest.callback(...earliest.args);
    } catch {
      // An exception in a timer callback is uncaught in the real runtime too; it does not stop the run.
    }
    return true;
  }
}

/** Deterministic randomness for a run: Math.random, UUIDs and random bytes from one seeded stream. */
export class VirtualRandom {
  private state: PrngState;

  constructor(seed: number | string) {
    this.state = seedPrng(`random:${seed}`);
  }

  float(): number {
    const [f, next] = nextFloat(this.state);
    this.state = next;
    return f;
  }

  u32(): number {
    const [u, next] = nextU32(this.state);
    this.state = next;
    return u;
  }

  fill<T extends ArrayBufferView>(view: T): T {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i += 4) {
      const u = this.u32();
      for (let j = 0; j < 4 && i + j < bytes.length; j++) bytes[i + j] = (u >>> (8 * j)) & 0xff;
    }
    return view;
  }

  /** A version-4 UUID from the stream. */
  uuid(): string {
    const b = this.fill(new Uint8Array(16));
    b[6] = ((b[6] as number) & 0x0f) | 0x40;
    b[8] = ((b[8] as number) & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export interface Patched {
  readonly clock: VirtualClock;
  readonly random: VirtualRandom;
  /**
   * Reads of the shared virtual state, by any code: the time (Date,
   * performance.now, scheduling a virtual timer) and the random stream. Code that reads them can tell orders of other invocations' turns
   * apart; the counter is the run's to reset.
   */
  readonly reads: { count: number };
  /** Put every global back. Safe to call twice. */
  restore(): void;
  /**
   * Run an effect's real I/O: timers the library schedules inside it are
   * real (backoff, timeouts); timers the handler schedules meanwhile stay
   * virtual. The clock, Date and randomness stay virtual throughout.
   */
  libraryIo<T>(perform: () => Promise<T>): Promise<T>;
}

type Global = Record<string, unknown>;

/** Web Crypto's asynchronous methods: real work that always finishes on its own. */
const subtleMethods = [
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "digest",
  "generateKey",
  "deriveKey",
  "deriveBits",
  "importKey",
  "exportKey",
  "wrapKey",
  "unwrapKey",
] as const;

export interface PatchOptions {
  /**
   * Called with the promise of every host call that is real asynchronous
   * work but not an effect (Web Crypto), so the run can wait for it like
   * I/O instead of guessing when it is done.
   */
  readonly trackIo?: <T>(work: Promise<T>) => Promise<T>;
}

/** Replace the nondeterministic globals for one run. Returns the handle that restores them. */
export function patchGlobals(seed: number | string, options: PatchOptions = {}): Patched {
  const clock = new VirtualClock();
  const random = new VirtualRandom(seed);
  const reads = { count: 0 };
  const inLibrary = () => libraryScope?.getStore() === true;
  /** Counts a read of the shared virtual state, an effect's own I/O included: its result may depend on it. */
  const read = (): void => {
    reads.count++;
  };
  const g = globalThis as unknown as Global;
  const undo: (() => void)[] = [];
  const define = (target: object, key: string, value: unknown): void => {
    undo.push(patchProperty(target, key, { value }));
  };

  const RealDate = Date;
  const VirtualDate = function (this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined || args.length === 0) read();
    if (new.target === undefined) return new RealDate(clock.now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [clock.now()] : args, new.target);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(VirtualDate, RealDate);
  Object.defineProperty(VirtualDate, "prototype", { value: RealDate.prototype, writable: false });
  Object.defineProperty(VirtualDate, "now", {
    value: () => {
      read();
      return clock.now();
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(VirtualDate, "name", { value: "Date" });

  define(g, "Date", VirtualDate);
  define(Math, "random", () => {
    read();
    return random.float();
  });
  // A virtual timer's due time is read from the clock when it is scheduled.
  define(g, "setTimeout", (cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (inLibrary()) return realSetTimeout(cb, ms, ...args);
    read();
    return clock.setTimeout(cb, ms, ...args);
  });
  define(g, "setInterval", (cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (inLibrary()) return realSetInterval(cb, ms, ...args);
    read();
    return clock.setInterval(cb, ms, ...args);
  });
  // Clearing dispatches on the handle: a virtual timer cancelled from library code, or a real
  // one cancelled from handler code, each reach the implementation that owns it.
  define(g, "clearTimeout", (id?: unknown) => {
    if (clock.owns(id)) clock.clear(id);
    else realClearTimeout(id as Parameters<typeof realClearTimeout>[0]);
  });
  define(g, "clearInterval", (id?: unknown) => {
    if (clock.owns(id)) clock.clear(id);
    else realClearInterval(id as Parameters<typeof realClearInterval>[0]);
  });
  const perf = g["performance"];
  if (perf && typeof perf === "object")
    define(perf, "now", () => {
      read();
      return clock.now() - virtualEpoch;
    });
  const cryptoObj = g["crypto"];
  if (cryptoObj && typeof cryptoObj === "object") {
    define(cryptoObj, "randomUUID", () => {
      read();
      return random.uuid();
    });
    define(cryptoObj, "getRandomValues", <T extends ArrayBufferView>(view: T) => {
      read();
      return random.fill(view);
    });
    const subtle = (cryptoObj as { subtle?: Record<string, unknown> }).subtle;
    const trackIo = options.trackIo;
    if (trackIo && subtle && typeof subtle === "object") {
      for (const name of subtleMethods) {
        const real = subtle[name];
        if (typeof real !== "function") continue;
        define(subtle, name, function (this: unknown, ...args: unknown[]) {
          return trackIo(Promise.resolve(real.apply(this, args)));
        });
      }
    }
  }

  let restored = false;
  return {
    clock,
    random,
    reads,
    libraryIo<T>(perform: () => Promise<T>): Promise<T> {
      return libraryScope ? libraryScope.run(true, perform) : perform();
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const u of undo.reverse()) u();
    },
  };
}

/** The longest timeout hosts accept: 2^31 - 1 ms. */
const maxTimeoutMs = 2 ** 31 - 1;

/** A real-time deadline: `expired` resolves after `ms` unless cancelled first. */
export function realDeadline(ms: number): { readonly expired: Promise<"expired">; cancel(): void } {
  let handle: ReturnType<typeof realSetTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    // Hosts fire a timeout above this after 1 ms; the longest they can wait (about 24.8 days) is as good as never.
    handle = realSetTimeout(() => resolve("expired"), Math.min(ms, maxTimeoutMs));
  });
  return { expired, cancel: () => realClearTimeout(handle) };
}

/** Yield to the real event loop so microtasks and pending I/O can make progress. */
export function realTick(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(() => resolve(), 0));
}

// Not in every host's types, so looked up loosely; captured before any patching.
const hostSetImmediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
  .setImmediate;
// workerd names itself in `navigator.userAgent` (Cloudflare, Compatibility flags: Global navigator,
// on by default since 2022-03-21) and is the host with `WebSocketPair` (Cloudflare, WebSockets).
const hostAgent = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent;
const inWorkerd =
  hostAgent === "Cloudflare-Workers" ||
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function";

/**
 * A turn of the real event loop without a timer's delay, where the host
 * gives one cheaply: Node's `setImmediate` (microseconds), after which every
 * pending microtask has run and I/O callbacks that were due have been
 * delivered. Null in workerd, which has `setImmediate` too but runs it as a
 * timer, about a millisecond like `setTimeout(0)`, and where nothing else
 * reaches the event loop (streams, bodies, message ports, crypto and the
 * cache all resolve without a turn of it), so a zero timer is the turn.
 * Measured in the Cloudflare Vitest pool (workerd 1.2026-10, 2026-10-30),
 * not documented: a workerd whose `setImmediate` became cheap would only
 * run slower here, never wrong.
 */
export const cheapEventLoopTurn: (() => Promise<void>) | null =
  hostSetImmediate && !inWorkerd
    ? () => new Promise((resolve) => hostSetImmediate.call(globalThis, () => resolve()))
    : null;

/** One turn of the real event loop: the cheap one where the host has it, else a zero timer. */
export function eventLoopTurn(): Promise<void> {
  return cheapEventLoopTurn ? cheapEventLoopTurn() : realTick();
}

export interface SettleContext {
  readonly clock: VirtualClock;
  /** Effects currently performing real I/O. */
  readonly inFlight: () => number;
  /** True once the invocation has been crashed; the promise is then abandoned. */
  readonly crashed: () => boolean;
  /** Called when nothing can make progress: no I/O, no timers, not done. */
  readonly stuck: () => void;
}

/**
 * Wait for a promise under the virtual clock: while it is pending, let real
 * I/O complete, and when the invocation is idle fire the next due timer.
 */
export async function settleOn<T>(promise: Promise<T>, ctx: SettleContext): Promise<T> {
  let done = false;
  let failed = false;
  let value: T | undefined;
  let error: unknown;
  const tracked = promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  for (;;) {
    await Promise.race([tracked, realTick()]);
    if (done) {
      if (failed) throw error;
      return value as T;
    }
    if (ctx.crashed()) return new Promise<T>(() => {});
    if (ctx.inFlight() > 0) continue;
    if (ctx.clock.fireNext()) continue;
    ctx.stuck();
    return new Promise<T>(() => {});
  }
}
