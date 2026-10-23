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
}

/** What a proxy tells the engine about an effect it is about to perform. */
export interface EffectPoint {
  readonly invocation: string;
  readonly target: string;
  readonly op: string;
  readonly args: JsonValue;
  /** Which faults make sense here; the engine only injects from this list. */
  readonly allowed: readonly FaultKind[];
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
  startInvocation(id: string): Invocation;
  /** Perform an asynchronous effect under fault injection and record it. */
  effect<T>(
    point: EffectPoint,
    perform: () => Promise<T>,
    summarize: (value: T) => JsonValue,
  ): Promise<T>;
  /** Perform a synchronous effect under fault injection and record it. */
  effectSync<T>(point: EffectPoint, perform: () => T, summarize: (value: T) => JsonValue): T;
  /** Declare that the run touched something Eutaxy cannot control. */
  unsupported(reason: string): void;
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
