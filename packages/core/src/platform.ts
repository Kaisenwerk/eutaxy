/**
 * The boundary between the engine and a platform. The engine owns the run
 * loop and fault injection; a platform owns how events reach the Worker and
 * what its bindings do. Everything crossing this boundary is plain data
 * except the two function-bearing objects below.
 */

import type { JsonValue } from "./canonical-json.ts";
import type { FaultKind } from "./faults.ts";
import type { ScenarioSpec } from "./scenario.ts";

/** One deliverable event, e.g. one attempt to deliver one queue message. */
export interface EventRef {
  readonly id: string;
  /** 1 for the first delivery, 2 for the first redelivery, and so on. */
  readonly attempt: number;
  readonly data: JsonValue;
  /**
   * Virtual time (ms since the epoch) before which the event is not
   * delivered, e.g. a resend after the caller's retry delay. Absent: as soon
   * as possible. The engine advances the virtual clock to it once nothing
   * else can move.
   */
  readonly at?: number;
  /**
   * What produced the event when it is not the scenario's drive, e.g. a
   * Durable Object alarm, so the platform knows how to deliver it.
   */
  readonly source?: string;
}

/** What a proxy tells the engine about an effect it is about to perform. */
export interface EffectPoint {
  readonly invocation: string;
  readonly target: string;
  readonly op: string;
  readonly args: JsonValue;
  /** Which faults make sense here; the engine only injects from this list. */
  readonly allowed: readonly FaultKind[];
  /**
   * Performing this effect runs user code that may make effects of its own
   * (a Durable Object call). Those are part of this effect's turn even when
   * the runtime does not carry async context into that code.
   */
  readonly hostsEffects?: boolean;
}

export interface EffectOptions {
  /**
   * Called when the effect is abandoned while its `perform` is still
   * running, because its invocation crashed inside it or its I/O hung: the
   * place to reset whatever the perform left busy (a Durable Object). For a
   * crash inside, it is called synchronously where the crash happens, in the
   * async context of the code the perform runs.
   */
  readonly onAbandon?: () => void;
  /**
   * The hosted code is `host`'s: an object's that stays alive after this
   * effect ends (a Durable Object, named `<target>/<object>`). The platform
   * enters that code through `RunHooks.hostedCode`, so an effect it makes is
   * this effect's while one of `host`'s effects is being performed and, once
   * none is, is work of `host`'s own after its answer (a promise it did not
   * await, a timer it set): an invocation `<host>/after`, whose effects are
   * turns of their own and take faults by their position in it, alive until
   * nothing of it can move and revived by work woken later; a crash in it
   * resets the object (`onAbandon`). Timers `host`'s code sets are its too.
   * Without `host`, what hosted code leaves running is the hosting
   * invocation's and ends with it.
   */
  readonly host?: string;
  /**
   * Whether an effect the hosted code makes may wait for its turn now. False
   * while the hosted code holds every other event out (a Durable Object
   * inside blockConcurrencyWhile): nothing else could enter it then, and it
   * could not notice its release, so the effect runs at once.
   */
  readonly mayPark?: () => boolean;
}

/** One invocation of the Worker, as the engine tracks it. */
export interface Invocation {
  readonly id: string;
  /** Resolves when the invocation is crashed by an injected fault. */
  readonly crashed: Promise<void>;
  isCrashed(): boolean;
}

/** What the engine offers a platform during one run. */
export interface RunHooks {
  /**
   * Start tracking an invocation; it becomes the running one.
   * @param options.bookkeeping Deprecated: use `bookkeeping()`. Tracks the
   * invocation without it ever becoming the running one.
   */
  startInvocation(id: string, options?: { readonly bookkeeping?: boolean }): Invocation;
  /**
   * The invocation the platform's own actions are recorded under (a dead
   * letter, a caller giving up, an end-of-run snapshot), started on first
   * use in the run. No fault crashes it and it never becomes the running
   * one, so it cannot take over the effects of the handler it was started
   * during.
   */
  bookkeeping(): string;
  /** Perform an asynchronous effect under fault injection and record it. */
  effect<T>(
    point: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
    options?: EffectOptions,
  ): Promise<T>;
  /** Perform a synchronous effect under fault injection and record it. */
  effectSync<T>(point: EffectPoint, perform: () => T, summarize: (value: T) => JsonValue): T;
  /** Declare that the run touched something Eutaxy cannot control. */
  unsupported(reason: string): void;
  /**
   * The invocation whose code is running now. Proxies that cannot tell which
   * invocation called them attribute their effects to it; with concurrent
   * invocations only one runs at a time, so this is always the caller.
   */
  running(): string;
  /**
   * Whether the invocation has set a virtual timer that has not fired or
   * been cleared: work it left running, for a platform that must know
   * before it treats the invocation's work as done.
   */
  timersPending(invocation: string): boolean;
  /**
   * Run `code` as `host`'s own while a call is still on its way into the
   * host: what an object's constructor does before the method the call
   * names can run (work behind its input gate). The code is the host's,
   * its timers virtual and the host's to be woken by, and the effects it
   * makes the entering call's; it is not the call itself, which starts
   * with `hostedCode`. While it runs, the entering call counts as code
   * that may be awaiting a timer of its own.
   */
  hostEntering<T>(host: string, code: () => T): T;
  /**
   * Run `code` as `host`'s own (see `EffectOptions.host`), where the runtime
   * does not carry async context into it: an object's method about to be
   * called, its alarm or WebSocket handler. `op` names the call the code is
   * (a stub call's method or property), so the code is matched to the
   * effect of the host's with that `op` whose call has not started. Timers
   * inside are virtual, as for handler code. Code already running as the
   * host's that enters again (a method calling another) stays what it was.
   */
  hostedCode<T>(host: string, code: () => T, op?: string): T;
  /** The platform dropped `host`'s instance (an eviction after a crash): work of its after an answer is gone with it. */
  hostReset(host: string): void;
  /**
   * Queue an event now, before the current delivery finishes, e.g. a resend
   * the caller makes as soon as it gives up while the handler's background
   * work still runs. Equivalent to returning it in `followUps`, except for
   * when it can start.
   */
  enqueue(event: EventRef): void;
  /** Record a state snapshot (not an effect point; never faulted). */
  snapshot(invocation: string, target: string, payload: JsonValue): void;
  /**
   * Wait for user code under the engine's virtual clock: real I/O completes,
   * timers fire while the invocation is idle, and once the invocation has
   * crashed the wait rejects with the engine's crash signal, seen on the
   * run's own tick (whatever the crash itself settled may never wake its
   * waiters: a Durable Object's reset tears down the task it happened in).
   * Platforms await handler and background promises through this, never
   * directly, and treat the crash signal as the invocation's end.
   */
  settle<T>(promise: Promise<T>, invocation: string): Promise<T>;
  /**
   * Run `code` as an attempt of `invocation`'s that the platform gives up on
   * once it has outlived `deadlineMs` of virtual time with its result still
   * pending (a Workflow step attempt past its `timeout`), or at once when
   * `deadlineMs` is 0 or less (a fault that says the attempt timed out). The
   * code is not stopped, as the runtime cannot stop it either: from then on
   * the effects it goes on to make are late turns. In a concurrent run a late
   * turn is offered at every decision but holds nothing: while only late
   * turns are parked, time may pass to the next timer or delayed event
   * instead, so what the late code still does lands before, between or after
   * what the invocation did since it gave up; once nothing else can move, the
   * late turns run. In a sequential run the late code runs on as it would,
   * before timers not yet due. The deadline is the engine's, not a timer of
   * the code's: it leaves no trace and does not count as reading the clock.
   */
  attempt<T>(invocation: string, code: () => T, deadlineMs: number): Attempt<T>;
}

/** An attempt started with `RunHooks.attempt`. */
export interface Attempt<T> {
  /** What the code returned. */
  readonly value: T;
  /** Resolves once the attempt is late (the deadline passed with its result pending); never, when it finished in time. */
  readonly late: Promise<void>;
}

export interface DeliveryResult {
  readonly status: "completed" | "errored" | "crashed";
  /** Events the platform's semantics require next, e.g. redeliveries. */
  readonly followUps: readonly EventRef[];
}

/**
 * What a platform package gives the engine to run a scenario: its events, how each is delivered to the
 * Worker or function, how state is reset before a run and snapshotted after it, and the assumptions a
 * verdict rests on.
 */
export interface Platform {
  readonly name: string;
  /** What a verdict rests on that this platform decides, one line each. */
  readonly assumptions: readonly string[];
  /**
   * True when `deliver` may be called again before an earlier delivery has
   * finished, which `maxConcurrentInvocations` above 1 needs. Such a
   * platform attributes effects per delivery or through `RunHooks.running`,
   * never through state shared between deliveries.
   */
  readonly concurrent?: boolean;
  /** Establish the scenario's initial state. Called before every run. */
  reset(spec: ScenarioSpec): Promise<void>;
  /** The events the scenario's drive produces, in order. */
  initialEvents(spec: ScenarioSpec): readonly EventRef[];
  /** Deliver one event to the Worker under the run's fault injection. */
  deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult>;
  /** The same scenario driven only by the events with these ids (for shrinking and regression tests). */
  restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec;
  /**
   * Events of the platform's own that the end of the run calls for. Asked
   * each time every event has been delivered and nothing is left to move;
   * what it answers is delivered like any other event, and it is asked
   * again until it answers none. (A stateful resource a crash reset and
   * nothing entered since is woken here, inside the run, so the end-of-run
   * snapshot reads it as its next event would find it.)
   */
  closingEvents?(spec: ScenarioSpec): readonly EventRef[];
  /** Called once all events are delivered; the place to record end-of-run state snapshots. */
  finish?(spec: ScenarioSpec, hooks: RunHooks): Promise<void>;
  /** Called when a run ends for any reason, after `finish` or after a failure: undo any per-run patching. */
  cleanup?(spec: ScenarioSpec): Promise<void>;
}
