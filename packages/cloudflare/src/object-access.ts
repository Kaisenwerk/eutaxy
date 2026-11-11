/**
 * Code run inside a Durable Object as one of its own events does (an alarm,
 * a WebSocket message), and the crash semantics that go with it: the effect
 * hosts the object's effects, work the object goes on with after it is the
 * object's own turns, an abandoned effect resets the object, an effect
 * inside blockConcurrencyWhile may not wait for a turn, and a crash drops
 * the instance, whose in-memory state goes with it.
 */

import {
  type DeliveryResult,
  type EffectPoint,
  type EventRef,
  type Invocation,
  invocationOf,
  type JsonValue,
  type RunHooks,
} from "@eutaxy/core";
import { type Outcome, runInvocation } from "@eutaxy/engine";
import { isServiceBinding } from "./services.ts";

/** The host an object's code runs as (`EffectOptions.host`): its namespace's target and its name. */
export function hostOf(target: string, object: string): string {
  return `${target}/${object}`;
}

/** Where a class's `method` is defined along `instance`'s prototype chain. */
function owner(instance: object, method: string): object | undefined {
  for (let o: object | null = instance; o !== null; o = Object.getPrototypeOf(o))
    if (Object.hasOwn(o, method)) return o;
  return undefined;
}

/** The host each instance's code runs as, set each time a call enters it. */
const hostOfInstance = new WeakMap<object, { hooks: RunHooks; host: string }>();
const hostingWrappers = new WeakSet<object>();

/**
 * Have the object's `method` run as the host's code (`RunHooks.hostedCode`)
 * when the runtime calls it next: the runtime carries no async context into
 * an object's code, so the method is wrapped where its class defines it, and
 * the wrapper looks the instance's host up; code the method spawns and does
 * not await carries the object's identity too.
 */
export function hostMethod(hooks: RunHooks, host: string, instance: unknown, method: string): void {
  if (instance === null || typeof instance !== "object") return;
  hostOfInstance.set(instance, { hooks, host });
  const where = owner(instance, method);
  if (!where) return;
  const descriptor = Object.getOwnPropertyDescriptor(where, method);
  if (!descriptor?.configurable) return;
  const hosted = (original: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const of = this !== null && typeof this === "object" ? hostOfInstance.get(this) : undefined;
      const call = () => original.apply(this, args);
      return of ? of.hooks.hostedCode(of.host, call, method) : call();
    };
  // A method, or an RPC property's getter: either runs the object's code when the call arrives.
  if (typeof descriptor.value === "function" && descriptor.writable) {
    if (hostingWrappers.has(descriptor.value)) return;
    const wrapper = hosted(descriptor.value as (...a: unknown[]) => unknown);
    hostingWrappers.add(wrapper);
    Object.defineProperty(where, method, { ...descriptor, value: wrapper });
  } else if (typeof descriptor.get === "function") {
    if (hostingWrappers.has(descriptor.get)) return;
    const wrapper = hosted(descriptor.get as (...a: unknown[]) => unknown);
    hostingWrappers.add(wrapper);
    Object.defineProperty(where, method, { ...descriptor, get: wrapper });
  }
}

/** Who each instance with a view over its env is and the run it belongs to, set each time a call enters it. */
const ownerOfEnv = new WeakMap<object, { hooks: RunHooks; binding: string; object: string }>();

/**
 * Under this key a callee's view of env (`calleeEnv`) gives the callee's
 * name, so an object constructed with that view has its bindings read back
 * to the names the scenario knows them by (`PEER` to `orders/PEER`).
 */
export const calleeOfEnv: unique symbol = Symbol.for("eutaxy.calleeOfEnv");

/**
 * Make an object's calls through its own service bindings the scenario's.
 * The runtime hands an object the Worker's real `env`, where a service
 * binding is not the scenario's script or callee: a call through it would
 * reach whatever the isolate holds under that name and fail or answer
 * unseen. So the instance's `env` is put behind a view under which a
 * service binding is the one the Worker itself sees (`worker()`, the
 * platform's env, under the binding's qualified name): the call is an
 * effect of whichever invocation the object's code is running as, answered
 * from the `service()` script or by the `callee()` hosted inside it, with
 * that binding's faults. The binding is resolved when first used, so
 * reading it off `env` does nothing. Without the platform's env, or when it
 * holds nothing under the name, the call ends the run `UNSUPPORTED`. The
 * object's other bindings are its own to use, unrecorded. An `env` the
 * class keeps elsewhere than `this.env` (a private field, a closure of its
 * constructor) is out of reach.
 *
 * A call leaves the object only once what the object wrote before it is
 * durable, as the runtime's output gate holds an outgoing message until the
 * writes before it are confirmed: around the start of each call the
 * object's gate (`gate.durable`, the storage's `sync()`) is left in
 * `gate.slot` for the binding's stub to wait on inside its effect. A fault
 * that resets the object after the call then finds those writes kept,
 * where a reset straight after an unflushed write would lose them and a
 * claim recorded before the call would look as if never made.
 */
export function ownEnv(
  hooks: RunHooks,
  binding: string,
  object: string,
  instance: unknown,
  worker?: () => object,
  gate?: {
    readonly slot: { pending: (() => Promise<void>) | undefined };
    readonly durable: () => Promise<void>;
  },
): void {
  if (instance === null || typeof instance !== "object") return;
  const viewed = ownerOfEnv.has(instance);
  ownerOfEnv.set(instance, { hooks, binding, object });
  if (viewed) return;
  const descriptor = Object.getOwnPropertyDescriptor(instance, "env");
  const env: unknown = descriptor?.value;
  if (!descriptor?.writable || env === null || typeof env !== "object") return;
  const callee = (env as { readonly [calleeOfEnv]?: unknown })[calleeOfEnv];
  /** The name the scenario knows the object's binding by. */
  const qualified = (name: string): string =>
    typeof callee === "string" ? `${callee}/${name}` : name;
  const refuse = (name: string): never => {
    const of = ownerOfEnv.get(instance) ?? { hooks, binding, object };
    const reason = `Durable Object ${of.binding} ${of.object} called the service binding ${name} through its own env, and the scenario's env holds no service binding ${qualified(name)} to answer it`;
    of.hooks.unsupported(reason);
    throw new Error(`eutaxy: ${reason}`);
  };
  const stubs = new Map<string, object>();
  const stubFor = (name: string): object => {
    let stub = stubs.get(name);
    if (!stub) {
      // What stands in when the scenario's env cannot answer: a method called, or awaited uncalled (an
      // RPC getter), is the refused call, rejecting as an RPC call does.
      const refused = Object.assign(async (): Promise<never> => refuse(name), {
        // biome-ignore lint/suspicious/noThenProperty: an RPC property is awaitable as well as callable
        then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          refused().then(onFulfilled, onRejected),
      });
      stub = new Proxy(
        {},
        {
          get(_t, prop) {
            // The binding itself is not a promise.
            if (prop === "then" || typeof prop === "symbol") return undefined;
            // The Worker's own stub for the binding, looked up now: the run's script or callee.
            const through = worker
              ? (Reflect.get(worker(), qualified(name)) as unknown)
              : undefined;
            if (through === null || typeof through !== "object") return refused;
            const member = Reflect.get(through, prop, through) as unknown;
            return typeof member === "function" && gate ? behindGate(member, gate) : member;
          },
        },
      );
      stubs.set(name, stub);
    }
    return stub;
  };
  (instance as { env: unknown }).env = new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof prop === "string" && isServiceBinding(value) ? stubFor(prop) : value;
    },
  });
}

/**
 * A method of a service binding as an object calls it: while the call (or
 * the await of an RPC getter) starts, the object's output gate is in the
 * slot for the stub to take. The start is synchronous, so no other call
 * sees it. Anything else read on the method is its own (the stub's guards).
 */
function behindGate(
  member: object,
  gate: {
    readonly slot: { pending: (() => Promise<void>) | undefined };
    readonly durable: () => Promise<void>;
  },
): object {
  const starting = <T>(start: () => T): T => {
    gate.slot.pending = gate.durable;
    try {
      return start();
    } finally {
      gate.slot.pending = undefined;
    }
  };
  type Then = (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => unknown;
  return new Proxy(member, {
    apply: (target, self, args) =>
      starting(() => Reflect.apply(target as (...a: unknown[]) => unknown, self, args)),
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key !== "then" || typeof value !== "function") return value;
      const then: Then = (ok, fail) => starting(() => (value as Then)(ok, fail));
      return then;
    },
  });
}

/** `EventRef.source` of an object's wake at the end of a run. */
export const wakeSource = "durable_object_wake";

/**
 * The event that wakes the object `id` of `binding`, the `n`-th of the run:
 * its instance was dropped by a crash and nothing has entered it since.
 */
export function wakeEvent(binding: string, id: string, object: string, n: number): EventRef {
  return {
    id: `wake:${binding}:${object}:${n}`,
    attempt: 1,
    source: wakeSource,
    data: { binding, id, object },
  };
}

/**
 * Wake an object the run's crashes left dropped, as its next event would:
 * the runtime constructs a new instance over the storage the old one left.
 * Without it only the end-of-run snapshot would construct the object, after
 * the run, where its constructor's requests, timers and clock are the real
 * ones. Here the constructor runs as the object's code inside one effect of
 * an invocation of its own, which hosts whatever effects it makes; the wake
 * itself takes no fault (it is the model's reading of the object, not an
 * event of the platform's), a fault on an effect the constructor makes
 * resets the object as anywhere else, and it is then woken again. A timer
 * the constructor leaves running is not followed (its code runs with no
 * context of the wake's), so the run is `UNSUPPORTED` rather than
 * snapshotted without what that work would have done.
 */
export async function deliverWake(
  event: EventRef,
  hooks: RunHooks,
  objects: ObjectAccess,
): Promise<DeliveryResult> {
  const { binding, id, object } = event.data as { binding: string; id: string; object: string };
  const invocation = invocationOf(event);
  const inv = hooks.startInvocation(invocation);
  let leftTimer = false;
  const status = await hostedInObject(
    hooks,
    inv,
    objects,
    binding,
    id,
    object,
    { invocation, target: `DO:${binding}`, op: "wake", args: { object }, allowed: [] },
    async () => {
      // Entered as the object's code, so that where the runtime carries the context a timer the
      // constructor sets is the object's own work, waited for like any work after an answer.
      await hooks.hostedCode(hostOf(`DO:${binding}`, object), () =>
        objects.run(binding, id, object, async () => undefined),
      );
      // Where it does not (workerd), such a timer is this invocation's, whose end drops it:
      // looked for while the invocation is alive.
      leftTimer = hooks.timersPending(invocation);
      return null;
    },
    () => null,
  );
  // The runtime carries no context of the wake into the constructor, so a timer it set is this
  // invocation's, which is over: nothing would fire it, and the snapshot would miss what it does.
  if (status === "completed" && leftTimer)
    hooks.unsupported(
      `Durable Object ${binding} ${object} was woken at the end of the run and its constructor left a timer running; work a constructor starts and does not await is not followed there`,
    );
  return { status, followUps: [] };
}

/** What a delivery into an object needs of its namespace: to run code inside one, and the crash semantics. */
export interface ObjectAccess {
  run<T>(
    binding: string,
    id: string,
    object: string,
    fn: (instance: unknown, live: DurableObjectState) => Promise<T>,
  ): Promise<T | undefined>;
  abort(binding: string, id: string): void;
  mayPark(binding: string, id: string): boolean;
  evict(binding: string, id: string): Promise<void>;
}

/**
 * One effect of `inv` performed inside the object `id` of `binding`: `perform`
 * runs as the effect, which hosts what the object does; a fault that
 * abandons it resets the object, and a crash evicts the instance. The
 * invocation's outcome.
 */
export async function hostedInObject<T>(
  hooks: RunHooks,
  inv: Invocation,
  objects: ObjectAccess,
  binding: string,
  id: string,
  object: string,
  point: EffectPoint,
  perform: () => Promise<T>,
  summarize: (value: T) => JsonValue,
): Promise<Outcome<T>["status"]> {
  const { status } = await runInvocation(hooks, inv, () =>
    hooks.effect({ ...point, hostsEffects: true }, perform, summarize, {
      host: hostOf(`DO:${binding}`, object),
      onAbandon: () => objects.abort(binding, id),
      mayPark: () => objects.mayPark(binding, id),
    }),
  );
  if (status === "crashed") {
    await objects.evict(binding, id);
    hooks.hostReset(hostOf(`DO:${binding}`, object));
  }
  return status;
}
