/**
 * Service bindings with the callee real. A scenario names the Worker behind a
 * binding (`callee(binding, { entry, config })`), and the test gives the
 * platform its module and the name from its wrangler config; the callee's
 * code then runs in the same simulation as the caller's, in the same
 * isolate, as Cloudflare runs both Workers on one thread (Workers, service
 * bindings). Each RPC method call or `fetch()` through the binding is one
 * effect, `Service:<binding>`, with the faults of a call in the network
 * (`crash_before`: it never reached the callee; `ambiguous`: the callee
 * acted and the answer was lost; `crash_after`: the caller died after it);
 * `error` is not among them, since what the callee throws is real. The
 * effect hosts the callee's invocation (`<caller invocation>/<binding>.<method>`,
 * `#<n>` for the n-th call of that method from the same caller invocation):
 * the entrypoint is constructed anew with a fresh `ExecutionContext` and the
 * callee's `env`, a view of the scenario's env under the callee's own names
 * (`DB` for `orders/DB`), so its code runs unchanged while its effects are
 * recorded under its own invocation, interleave as turns and take faults by
 * their position within it. What the callee throws reaches the caller as a
 * new error with its name, message and serializable own properties, a
 * built-in class as itself (Workers RPC, error handling); a fault that
 * crashes the callee ends its invocation and the caller sees an `Error`
 * thrown from the call. The callee's `waitUntil` work finishes before its
 * answer crosses: one of the orders the runtime allows.
 */

import { type FaultKind, type JsonValue, toJson } from "@eutaxy/core";
import { hostInvocation, isRedirect, type Outcome, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext } from "./background.ts";
import { isPlainData } from "./durable-objects.ts";
import { constructEntrypoint } from "./entrypoint.ts";
import { type ProxyContext, pointAt, refuse } from "./proxy-context.ts";
import { describeError, entrypointClass, rpcMethod } from "./rpc.ts";
import type { CalleeSetup } from "./scenario.ts";
import { recordRequest, scriptedError, serviceStub } from "./services.ts";

/**
 * The callee's module as the test gives it: the Worker's name from its
 * wrangler config, which qualifies its bindings, its exports, and what the
 * caller's service binding carries in its own config: the `entrypoint` the
 * binding reaches (the scenario's `callee()` may name one too, and wins)
 * and the `props` the callee reads from `ctx.props`.
 */
export interface CalleeModule {
  readonly name: string;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly entrypoint?: string;
  readonly props?: Readonly<Record<string, JsonValue>>;
}

/** The faults a call to a real callee admits; `error` is the callee's own to throw. */
export const callFaults: readonly FaultKind[] = ["crash_before", "ambiguous", "crash_after"];

/** What the platform keeps per run about its callees; cleared before each run. */
export class CalleeState {
  /** Calls so far per caller invocation, binding and method, to name each hosted invocation. */
  readonly counts = new Map<string, number>();
  clear(): void {
    this.counts.clear();
  }
}

/**
 * The callee's `env`: the scenario's env seen under the callee's own names,
 * each mapped onto `<name>/<key>`. Over the platform's proxied env the
 * entries are the proxies, so the callee's effects are recorded under their
 * qualified targets, and an alias (`<name>/STOCK` for the caller's `STOCK`)
 * is already resolved; over workerd's raw env (a callee's Durable Object,
 * which the runtime constructs with the main Worker's env) the aliases are
 * given here, so the shared binding is there under the callee's name too.
 */
export function calleeEnv(
  name: string,
  env: object,
  aliases: Readonly<Record<string, string>> = {},
): object {
  const prefix = `${name}/`;
  const source = env as Record<string, unknown>;
  /** The key of `env` a property of the view reads: the qualified name, or the binding it is an alias of. */
  const keyOf = (prop: string | symbol): string | undefined => {
    if (typeof prop !== "string") return undefined;
    const qualified = `${prefix}${prop}`;
    return qualified in source ? qualified : (aliases[qualified] ?? qualified);
  };
  const aliasKeys = Object.keys(aliases).filter(
    (a) => a.startsWith(prefix) && (aliases[a] ?? "") in source,
  );
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_t, prop) {
      const key = keyOf(prop);
      return key === undefined ? undefined : source[key];
    },
    has(_t, prop) {
      const key = keyOf(prop);
      return key !== undefined && key in source;
    },
    ownKeys: () => [
      ...new Set(
        [...Reflect.ownKeys(source).filter((k): k is string => typeof k === "string"), ...aliasKeys]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length)),
      ),
    ],
    getOwnPropertyDescriptor(_t, prop) {
      const key = keyOf(prop);
      if (key === undefined || !(key in source)) return undefined;
      return { value: source[key], enumerable: true, configurable: true, writable: false };
    },
  });
}

/**
 * The error the caller sees for what the callee threw: a new error with the
 * name and message, a built-in class as itself, and the serializable own
 * properties the thrown error carried (Workers RPC, error handling, enhanced
 * error serialization). Nothing of the original's identity or stack.
 */
export function crossingError(error: unknown): Error {
  const crossed = scriptedError(describeError(error));
  if (error instanceof Error) {
    for (const key of Object.keys(error)) {
      if (key === "name" || key === "message" || key === "stack") continue;
      try {
        Object.defineProperty(crossed, key, {
          value: structuredClone((error as unknown as Record<string, unknown>)[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } catch {
        // Not serializable: it does not cross.
      }
    }
  }
  return crossed;
}

/**
 * The fetch handler the binding reaches: the named entrypoint's method when
 * the setup names one, else the default export's (a handler object's `fetch`,
 * or an entrypoint class's method).
 */
function fetchHandlerOf(
  exports: Readonly<Record<string, unknown>>,
  entrypoint: string | undefined,
  ctx: ExecutionContext,
  env: object,
): ((request: Request) => unknown) | undefined {
  const def = entrypoint === undefined ? exports["default"] : exports[entrypoint];
  if (typeof def === "function") {
    const instance = constructEntrypoint(def, "WorkerEntrypoint", ctx, env) as {
      fetch?: (request: Request) => unknown;
    };
    return typeof instance.fetch === "function" ? instance.fetch.bind(instance) : undefined;
  }
  if (typeof def === "object" && def !== null) {
    const handler = def as {
      fetch?: (request: Request, env: object, ctx: ExecutionContext) => unknown;
    };
    return typeof handler.fetch === "function"
      ? (request) => handler.fetch?.call(handler, request, env, ctx)
      : undefined;
  }
  return undefined;
}

/**
 * The getter RPC exposes under a name: one the class or a superclass defines
 * on its prototype. An instance field is not reachable over RPC (workerd:
 * "The RPC receiver does not implement the method").
 */
function rpcGetter(instance: object, name: string): (() => unknown) | undefined {
  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    const own = Object.getOwnPropertyDescriptor(proto, name);
    if (!own) continue;
    return typeof own.get === "function" ? own.get : undefined;
  }
  return undefined;
}

/** The stub a Worker sees under a service binding whose callee runs for real. */
export function proxyCallee(
  binding: string,
  ctx: ProxyContext,
  setup: CalleeSetup,
  module: CalleeModule,
  env: object,
  state: CalleeState,
): object {
  const target = `Service:${binding}`;
  const view = calleeEnv(module.name, env);
  const entrypointName = setup.entrypoint ?? module.entrypoint;
  const props = module.props ?? {};
  const unsupported = (what: string): never => refuse(ctx, `callee ${binding}: ${what}`);
  const point = (op: string, args: JsonValue) => pointAt(ctx, target, op, args, callFaults);
  /** The hosted invocation's id: the n-th call of a method from one caller invocation is `#n`. */
  const invocationId = (method: string): string => {
    const key = `${ctx.currentInvocation()}/${binding}.${method}`;
    const n = (state.counts.get(key) ?? 0) + 1;
    state.counts.set(key, n);
    return n === 1 ? key : `${key}#${n}`;
  };

  /** The callee's code as an invocation of its own inside the call: the handler, then its background work. */
  const invoke = <T>(
    method: string,
    work: (executionContext: ExecutionContext) => T | Promise<T>,
  ): Promise<Outcome<T>> => {
    const hooks = ctx.hooks;
    const id = invocationId(method);
    return hostInvocation(hooks, id, async (inv) => {
      const background: Promise<unknown>[] = [];
      const ran = await runInvocation(hooks, inv, () =>
        work(executionContext(background, undefined, props)),
      );
      // A cut-off here crashes the callee after it answered: the answer stands, work not started is lost.
      if (ran.status !== "crashed") await drainBackground(hooks, inv, id, target, background);
      return ran;
    });
  };

  /** What the caller gets out of the callee's outcome: the value, the error as RPC carries it, or an error for a crash. */
  const answer = <T>(outcome: Outcome<T>, method: string): T => {
    if (outcome.status === "completed") return outcome.value;
    if (outcome.status === "errored") throw crossingError(outcome.error);
    throw new Error(
      `the Worker behind service binding ${binding} crashed while handling ${method}`,
    );
  };

  /**
   * Arguments travel by copy, as plain data: a function, a stub or a stream is
   * a capability the model lacks, and a class instance is what RPC refuses
   * (structuredClone would silently make a plain object of it).
   */
  const copied = (method: string, args: readonly unknown[]): unknown[] => {
    if (!args.every((a) => isPlainData(a)))
      return unsupported(
        `the arguments of ${method} are not plain data (a stub, a function, a stream or a class instance); RPC carries plain data only`,
      );
    try {
      return structuredClone([...args]);
    } catch {
      return unsupported(`the arguments of ${method} cannot be copied as RPC copies them`);
    }
  };

  /** A result passed back to the caller, by copy; one that is not plain data cannot be followed. */
  const plain = (method: string, value: unknown): unknown => {
    if (!isPlainData(value))
      unsupported(
        `${method} returned something that is not plain data (a stub, a function or a stream); RPC capabilities are not modelled`,
      );
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  };

  const entrypoint = (): unknown => {
    const cls = entrypointClass(undefined, module.exports, entrypointName);
    if (typeof cls !== "function")
      unsupported(
        `${entrypointName === undefined ? "the default export" : `export ${entrypointName}`} of ${module.name} is not a WorkerEntrypoint class`,
      );
    return cls;
  };

  const summarize = (value: unknown): JsonValue => ({ value: toJson(value) });

  return serviceStub(binding, ctx, {
    call: (method, args) => {
      // Copied now, as RPC copies at the call: what the caller does to its arguments after calling
      // (while the call waits for its turn) does not reach the callee. A refused argument rejects the
      // call's promise, as the real stub's does.
      let copy: unknown[];
      try {
        copy = copied(method, args);
      } catch (err) {
        return Promise.reject(err);
      }
      return ctx.hooks.effect(
        point(method, { args: args.map((a) => toJson(a)) }),
        async () => {
          const cls = entrypoint();
          const outcome = await invoke(method, (executionContext) => {
            const instance = constructEntrypoint(cls, "WorkerEntrypoint", executionContext, view);
            const fn = rpcMethod(instance, method);
            if (!fn)
              throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
            return fn.apply(instance, copy);
          });
          return plain(method, answer(outcome, method));
        },
        summarize,
      );
    },
    property: (name) =>
      ctx.hooks.effect(
        point(name, { property: true }),
        async () => {
          const cls = entrypoint();
          const outcome = await invoke(name, (executionContext) => {
            const instance = constructEntrypoint(cls, "WorkerEntrypoint", executionContext, view);
            const getter = rpcGetter(instance, name);
            if (!getter)
              throw new TypeError(`The RPC receiver does not implement the method "${name}".`);
            return getter.call(instance);
          });
          return plain(name, answer(outcome, name));
        },
        summarize,
      ),
    async fetch(request) {
      const { method, headers, body } = await recordRequest(request);
      return ctx.hooks.effect(
        point(method, { url: request.url, method, headers, body }),
        async () => {
          const outcome = await invoke("fetch", (executionContext) => {
            const handler = fetchHandlerOf(module.exports, entrypointName, executionContext, view);
            if (!handler)
              return unsupported(
                `${entrypointName === undefined ? module.name : `export ${entrypointName} of ${module.name}`} has no fetch handler`,
              );
            return handler(request);
          });
          const response = answer(outcome, "fetch");
          if (!(response instanceof Response))
            return unsupported(
              `${module.name}'s fetch handler returned something that is not a Response`,
            );
          // workerd follows a redirect from the callee as fetch does; only the first answer ran here.
          if (isRedirect(response.status) && request.redirect !== "manual")
            return unsupported(
              `${module.name} answered ${method} ${new URL(request.url).pathname} with a ${response.status} redirect, which the runtime would follow; fetch with redirect: "manual"`,
            );
          return response;
        },
        (r) => ({ status: r.status }),
      );
    },
  });
}
