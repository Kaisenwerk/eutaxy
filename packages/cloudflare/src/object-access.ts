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
import { isD1 } from "./d1.ts";
import { isR2 } from "./r2.ts";
import type { ServiceSetup } from "./scenario.ts";
import { isServiceBinding, scriptedError } from "./services.ts";
import { isWorkflowBinding } from "./workflows.ts";

/** A Durable Object namespace as the env shows it. */
export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

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

/**
 * Under this key a callee's view of env (`calleeEnv`) gives the callee's
 * name, so an object constructed with that view has its bindings read back
 * to the names the scenario knows them by (`PEER` to `orders/PEER`).
 */
export const calleeOfEnv: unique symbol = Symbol.for("eutaxy.calleeOfEnv");

/**
 * Make an object's calls through its own bindings the scenario's. The
 * runtime hands an object the Worker's real `env`, where a service binding
 * is not the scenario's script or callee (a call through it would reach
 * whatever the isolate holds under that name and fail or answer unseen),
 * a database or bucket is the real one, whose calls nothing records or
 * faults, and a Workflow binding is the local engine, which would run the
 * class on the real clock. So the instance's `env` is put behind a view
 * under which every binding is the one the
 * Worker itself sees (`worker()`, the platform's env, under the binding's
 * qualified name): the call is an effect of whichever invocation the
 * object's code is running as, with that binding's faults: a service's
 * answered from the `service()` script or by the `callee()` hosted inside
 * it, a statement or a bucket operation performed on the real store, a
 * Workflow instance created in the model, a call into another object the
 * stub call it is from the Worker; and a call on a binding of a
 * kind the model does not cover is refused as it is from the Worker, never
 * passed on. The binding is resolved when first used, so reading it off
 * `env` does nothing. Without the platform's env, or when it holds nothing
 * under the name, a service call ends the run `UNSUPPORTED`, and any other
 * binding is the object's own, unrecorded. A
 * class given the platform's base (`simulateConstruction`) is constructed
 * with the view (`envView`) and this only tells it whose it is; for any
 * other the view is in place once the constructor has returned, and the
 * `env` parameter a constructor keeps for itself is out of reach either
 * way.
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
  gate?: EnvGate,
): void {
  if (instance === null || typeof instance !== "object") return;
  const descriptor = Object.getOwnPropertyDescriptor(instance, "env");
  const env: unknown = descriptor?.value;
  if (env === null || typeof env !== "object") return;
  // Constructed with the view already (`envView`, through the class's base): whose it is, for this run.
  const known = ownerOfView.get(env);
  if (known) {
    Object.assign(known, { hooks, binding, object });
    return;
  }
  if (!descriptor?.writable) return;
  (instance as { env: unknown }).env = envView(env, { hooks, binding, object }, worker, gate);
}

/**
 * The env an object is constructed with outside a run (the reset constructs
 * each seeded object to clear and seed it). No run is there to record a
 * call, and the isolate's own binding must not be reached either: a method
 * of a service binding the scenario scripts (`scripted`, by the binding's
 * name there) is answered from the script as it will be in the run, so a
 * constructor that loads from one comes up; anything else through a
 * service binding (a `fetch()`, a binding with a callee or with no script)
 * is refused, and so are a call on a Workflow binding, which would start
 * an instance in the local engine, and a call into another object, which
 * would run that object for real and leave it up. A database or a bucket is the real one
 * there, as it is the reset's own: what a constructor writes to one while
 * its object is reset stays unless that store's setup step comes after the
 * object's. The
 * instance is evicted before the run, whose first call constructs the
 * object again, inside the run.
 */
export function outsideRunEnv(
  env: object,
  scripted: (binding: string) => ServiceSetup | undefined = () => undefined,
): object {
  const callee = (env as { readonly [calleeOfEnv]?: unknown })[calleeOfEnv];
  const qualified = (name: string): string =>
    typeof callee === "string" ? `${callee}/${name}` : name;
  const stubs = new Map<string, object>();
  const stubFor = (name: string): object => {
    let stub = stubs.get(name);
    if (!stub) {
      const member = (method: string): object => {
        const answer = async (): Promise<unknown> => {
          const script = scripted(qualified(name));
          const reply =
            script === undefined || method === "fetch" || method === "connect"
              ? undefined
              : script.methods === undefined
                ? { returns: null }
                : Object.hasOwn(script.methods, method)
                  ? script.methods[method]
                  : undefined;
          if (reply === undefined)
            throw new Error(
              `eutaxy: a Durable Object's constructor called ${method} on the service binding ${name} while the scenario's objects were being reset, outside a run, and no service() script answers it there`,
            );
          if ("throws" in reply) throw scriptedError(reply.throws);
          return structuredClone(reply.returns);
        };
        return Object.assign(answer, {
          // biome-ignore lint/suspicious/noThenProperty: an RPC property is awaitable as well as callable
          then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            answer().then(onFulfilled, onRejected),
        });
      };
      stub = new Proxy(
        {},
        {
          get: (_t, prop) =>
            prop === "then" || typeof prop === "symbol" ? undefined : member(prop),
        },
      );
      stubs.set(name, stub);
    }
    return stub;
  };
  /** A Workflow binding whose every call is refused: no run is there to hold the instance. */
  const flows = new Map<string, object>();
  const flowFor = (name: string, own: object): object => {
    let flow = flows.get(name);
    if (!flow) {
      flow = new Proxy(own, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== "function" || typeof prop !== "string") return value;
          return async (): Promise<never> => {
            throw new Error(
              `eutaxy: a Durable Object's constructor called ${prop} on the Workflow binding ${name} while the scenario's objects were being reset, outside a run, where no instance can be created or read`,
            );
          };
        },
      });
      flows.set(name, flow);
    }
    return flow;
  };
  /**
   * A namespace whose stubs refuse every call: the object called would run
   * for real, on the real clock, and stay up into the run with what the
   * call left in it. Ids are the namespace's own.
   */
  const namespaces = new Map<string, object>();
  const namespaceFor = (name: string, own: object): object => {
    let namespace = namespaces.get(name);
    if (!namespace) {
      const refused = (method: string): object => {
        const call = async (): Promise<never> => {
          throw new Error(
            `eutaxy: a Durable Object's constructor called ${method} on an object of ${name} while the scenario's objects were being reset, outside a run, where a call into another object is not made`,
          );
        };
        return Object.assign(call, {
          // biome-ignore lint/suspicious/noThenProperty: an RPC property is awaitable as well as callable
          then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            call().then(onFulfilled, onRejected),
        });
      };
      namespace = new Proxy(own, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (typeof value !== "function") return value;
          if (prop !== "get" && prop !== "getByName") return value.bind(target);
          return (...args: unknown[]) =>
            new Proxy(Reflect.apply(value, target, args) as object, {
              get(stub, key) {
                // The stub is not a promise; its id and name are its own.
                if (typeof key !== "string" || key === "then" || key === "id" || key === "name")
                  return key === "then" ? undefined : (Reflect.get(stub, key, stub) as unknown);
                return refused(key);
              },
            });
        },
      });
      namespaces.set(name, namespace);
    }
    return namespace;
  };
  return new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== "string") return value;
      // A service binding first: in workerd it answers every duck type.
      if (isServiceBinding(value)) return stubFor(prop);
      if (isDurableObjectNamespace(value)) return namespaceFor(prop, value);
      return isWorkflowBinding(value) ? flowFor(prop, value) : value;
    },
  });
}

/** What an object's output gate needs: the slot a call leaves it in, and the wait itself. */
export interface EnvGate {
  readonly slot: { pending: (() => Promise<void>) | undefined };
  readonly durable: () => Promise<void>;
}

/** Whose each view over an env is: the object and the run a refusal is reported to. */
const ownerOfView = new WeakMap<object, { hooks: RunHooks; binding: string; object: string }>();

/**
 * The view `ownEnv` puts over an object's `env`, made on its own so that a
 * class given a base of the platform's (`simulatedBase`) is constructed
 * with it and its constructor's first line already reads the scenario's
 * bindings. `owner` is told again at each entry into the object.
 */
export function envView(
  env: object,
  owner: { hooks: RunHooks; binding: string; object: string },
  worker?: () => object,
  gate?: EnvGate,
): object {
  const callee = (env as { readonly [calleeOfEnv]?: unknown })[calleeOfEnv];
  /** The name the scenario knows the object's binding by. */
  const qualified = (name: string): string =>
    typeof callee === "string" ? `${callee}/${name}` : name;
  const refuse = (name: string): never => {
    const reason = `Durable Object ${owner.binding} ${owner.object} called the service binding ${name} through its own env, and the scenario's env holds no service binding ${qualified(name)} to answer it`;
    owner.hooks.unsupported(reason);
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
            return typeof member === "function" ? calling(member, owner, gate) : member;
          },
        },
      );
      stubs.set(name, stub);
    }
    return stub;
  };
  /**
   * The scenario's database, bucket or Workflow under the object's binding
   * `name`, or the object's own. `flow` tells a Workflow, whose `create()`
   * and `get()` answer with an instance to call later.
   */
  const modelled = new Map<string, object>();
  const modelledFor = (name: string, own: object, flow: boolean): object => {
    let through = modelled.get(name);
    if (!through) {
      through = new Proxy(own, {
        get(target, prop) {
          // The Worker's own proxy for the binding, looked up now: its effects carry the run.
          const model = worker ? (Reflect.get(worker(), qualified(name)) as unknown) : undefined;
          if (model === null || typeof model !== "object" || model === target) {
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          }
          const member = Reflect.get(model, prop, model) as unknown;
          if (typeof member !== "function") return member;
          // A statement is executed later: that, not preparing it, is the object's call.
          if (prop === "prepare")
            return (...args: unknown[]) =>
              handedView(Reflect.apply(member, model, args) as object, owner, gate, "bind");
          const call = calling(member.bind(model), owner, gate);
          if (!flow || (prop !== "create" && prop !== "get")) return call;
          // Creating or finding an instance is the object's call, and so is each call on it after.
          return async (...args: unknown[]) =>
            handedView(
              (await Reflect.apply(
                call as (...a: unknown[]) => unknown,
                undefined,
                args,
              )) as object,
              owner,
              gate,
            );
        },
      });
      modelled.set(name, through);
    }
    return through;
  };
  /**
   * The scenario's namespace under the object's binding `name`, or the
   * object's own: a call on a stub it gives is the object's call into
   * another object (or into itself, as the runtime allows).
   */
  const namespaces = new Map<string, object>();
  const namespaceFor = (name: string, own: object): object => {
    let namespace = namespaces.get(name);
    if (!namespace) {
      namespace = new Proxy(own, {
        get(target, prop) {
          const model = worker ? (Reflect.get(worker(), qualified(name)) as unknown) : undefined;
          const through = model === null || typeof model !== "object" ? target : model;
          const member = Reflect.get(through, prop, through) as unknown;
          if (typeof member !== "function") return member;
          if (through === target || (prop !== "get" && prop !== "getByName"))
            return member.bind(through);
          return (...args: unknown[]) => {
            const stub = Reflect.apply(member, through, args) as object;
            return new Proxy(stub, {
              get(to, key) {
                const value = Reflect.get(to, key, to) as unknown;
                // Unbound: the stub's members are callable and awaitable as they are.
                return typeof value === "function" ? calling(value, owner, gate) : value;
              },
            });
          };
        },
      });
      namespaces.set(name, namespace);
    }
    return namespace;
  };
  const view = new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof prop !== "string") return value;
      // A service binding first: in workerd it answers every duck type.
      if (isServiceBinding(value)) return stubFor(prop);
      if (isD1(value) || isR2(value)) return modelledFor(prop, value, false);
      if (isWorkflowBinding(value)) return modelledFor(prop, value, true);
      if (isDurableObjectNamespace(value)) return namespaceFor(prop, value);
      if (!worker) return value;
      // Anything else is what the Worker sees under the name: a binding of a kind the model does not
      // cover with every call refused, a var as it is.
      const seen = Reflect.get(worker(), qualified(prop)) as unknown;
      return seen === undefined ? value : seen;
    },
  });
  ownerOfView.set(view, owner);
  return view;
}

/**
 * What a binding handed an object to call later (a D1 statement, a Workflow
 * instance): each method called is the object's call (a statement's `run`,
 * `all`, `first`, `raw`; an instance's `status`, `sendEvent`), and the
 * method named `again` (a statement's `bind`) gives another such thing.
 * What else is read of it (`batch()` reads a statement's text) is its own.
 */
function handedView(
  handed: object,
  owner: { hooks: RunHooks; binding: string; object: string },
  gate: EnvGate | undefined,
  again?: string,
): object {
  return new Proxy(handed, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (key === again)
        return (...values: unknown[]) =>
          handedView(Reflect.apply(value, target, values) as object, owner, gate, again);
      return calling(value.bind(target), owner, gate);
    },
  });
}

/**
 * A method of a binding as an object calls it. The call (or the await of
 * an RPC getter) starts as the object's code, which it is: in a
 * method it already runs as such, but the runtime carries no context into
 * a constructor, whose call would otherwise be a turn of nobody's inside
 * the call that is entering the object (`RunHooks.hostEntering`). And
 * while it starts, the object's output gate is in the slot for the stub to
 * take. The start is synchronous, so no other call sees the slot. Anything
 * else read on the method is its own (the stub's guards).
 */
function calling(
  member: object,
  owner: { hooks: RunHooks; binding: string; object: string },
  gate: EnvGate | undefined,
): object {
  const starting = <T>(start: () => T): T => {
    const behind = (): T => {
      if (!gate) return start();
      gate.slot.pending = gate.durable;
      try {
        return start();
      } finally {
        gate.slot.pending = undefined;
      }
    };
    // Test doubles for the hooks may lack it; the run's has it. Only the start is the entering
    // code: a constructor that starts a call and returns is not waiting on it, so the promise is
    // handed out around the hook, not through it.
    if (typeof owner.hooks.hostEntering !== "function") return behind();
    let started: { readonly value: T } | undefined;
    owner.hooks.hostEntering(hostOf(`DO:${owner.binding}`, owner.object), () => {
      started = { value: behind() };
    });
    return (started as unknown as { readonly value: T }).value;
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
