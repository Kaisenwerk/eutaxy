/**
 * Code run inside a Durable Object as one of its own events does (an alarm,
 * a WebSocket message), and the crash semantics that go with it: the effect
 * hosts the object's effects, work the object goes on with after it is the
 * object's own turns, an abandoned effect resets the object, an effect
 * inside blockConcurrencyWhile may not wait for a turn, and a crash drops
 * the instance, whose in-memory state goes with it.
 */

import type { EffectPoint, Invocation, JsonValue, RunHooks } from "@eutaxy/core";
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

/** Who each guarded instance is and the run it belongs to, set each time a call enters it. */
const guardOfInstance = new WeakMap<object, { hooks: RunHooks; binding: string; object: string }>();

/**
 * Keep an object's calls on its own service bindings from passing for the
 * scenario's. The runtime hands an object the Worker's real `env`, where a
 * service binding is never the scenario's script or callee: a call through
 * it would reach whatever the isolate holds under that name and fail or
 * answer outside the simulation, unseen. So the instance's `env` is put
 * behind a view under which every call on a service binding ends the run
 * `UNSUPPORTED` with the reason. Reading the binding does nothing; the
 * object's other bindings are its own to use, unrecorded, as before. An
 * `env` the class keeps elsewhere than `this.env` (a private field, a
 * closure of its constructor) is out of reach.
 */
export function guardEnv(
  hooks: RunHooks,
  binding: string,
  object: string,
  instance: unknown,
): void {
  if (instance === null || typeof instance !== "object") return;
  const guarded = guardOfInstance.has(instance);
  guardOfInstance.set(instance, { hooks, binding, object });
  if (guarded) return;
  const descriptor = Object.getOwnPropertyDescriptor(instance, "env");
  const env: unknown = descriptor?.value;
  if (!descriptor?.writable || env === null || typeof env !== "object") return;
  const refuse = (name: string): never => {
    const of = guardOfInstance.get(instance) ?? { hooks, binding, object };
    const reason = `Durable Object ${of.binding} ${of.object} called the service binding ${name} through its own env: an object's own binding calls are outside the simulation, so no service() script or callee() answers them`;
    of.hooks.unsupported(reason);
    throw new Error(`eutaxy: ${reason}`);
  };
  const stubs = new Map<string, object>();
  const stubFor = (name: string): object => {
    let stub = stubs.get(name);
    if (!stub) {
      // A method of the binding, `fetch()` and `connect()` among them: called, it is the refused call,
      // rejecting as an RPC call does; awaited uncalled (an RPC getter, `await env.PEER.enabled`), the same.
      const refused = Object.assign(async (): Promise<never> => refuse(name), {
        // biome-ignore lint/suspicious/noThenProperty: an RPC property is awaitable as well as callable
        then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          refused().then(onFulfilled, onRejected),
      });
      stub = new Proxy(
        {},
        {
          // The binding itself is not a promise.
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : refused),
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
