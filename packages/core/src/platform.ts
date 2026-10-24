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
   * Start tracking an invocation; it becomes the running one. With
   * `bookkeeping`, it only records the platform's own actions (a dead
   * letter, a caller giving up) and never becomes the running one, so it
   * cannot take over the effects of the handler it was started during.
   */
  startInvocation(id: string, options?: { readonly bookkeeping?: boolean }): Invocation;
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
   * timers fire while the invocation is idle, and a crashed invocation's
   * promise is abandoned. Platforms await handler and background promises
   * through this, never directly.
   */
  settle<T>(promise: Promise<T>, invocation: string): Promise<T>;
}

export interface DeliveryResult {
  readonly status: "completed" | "errored" | "crashed";
  /** Events the platform's semantics require next, e.g. redeliveries. */
  readonly followUps: readonly EventRef[];
}

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
  /** Called once all events are delivered; the place to record end-of-run state snapshots. */
  finish?(spec: ScenarioSpec, hooks: RunHooks): Promise<void>;
  /** Called when a run ends for any reason, after `finish` or after a failure: undo any per-run patching. */
  cleanup?(spec: ScenarioSpec): Promise<void>;
}
