/**
 * Service bindings with the callee scripted. A Worker reaches a peer through
 * `env.BINDING`, by RPC method or by `fetch()`; Cloudflare routes the call on
 * the same thread and retries nothing (Workers, service bindings). The real
 * binding is never called here: the scenario's `service()` setup scripts the
 * replies, and each call is one effect with the faults of a Durable Object
 * stub call, where `crash_before` and `error` mean the call never reached
 * the callee, `ambiguous` that it acted and the answer was lost, and
 * `crash_after` that the caller died after it.
 */

import { type EffectPoint, type JsonValue, toJson, writeFaults } from "@eutaxy/core";
import { findResponse, isRedirect, parseBody, replyOf, toResponse } from "@eutaxy/engine";
import type { ProxyContext } from "./d1.ts";
import type { ScriptedReply, ServiceSetup } from "./scenario.ts";

/** Marks of the other kinds of binding, which a service binding's duck type must not carry. */
const otherKinds = ["prepare", "idFromName", "head", "createBatch"];

/**
 * Whether an env value is a service binding (the runtime's `Fetcher`). In
 * workerd it is an RPC stub whose every property read yields a callable, so
 * duck typing alone would take it for any other kind: the runtime's class is
 * checked first, and the duck type (fetch and connect, none of the other
 * kinds' marks) serves test doubles.
 */
export function isServiceBinding(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const fetcher = (globalThis as { Fetcher?: unknown }).Fetcher;
  if (typeof fetcher === "function" && value instanceof fetcher) return true;
  const ctor = Object.getPrototypeOf(value)?.constructor as { name?: string } | undefined;
  if (ctor?.name === "Fetcher") return true;
  const v = value as Record<string, unknown>;
  return (
    typeof v["fetch"] === "function" &&
    typeof v["connect"] === "function" &&
    otherKinds.every((k) => typeof v[k] !== "function")
  );
}

/** The built-in error classes RPC carries across as themselves (workerd keeps the type). */
const builtInErrors: { readonly [name: string]: new (message: string) => Error } = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

/**
 * The error the caller sees for a `throws` reply, `"<Name>: <message>"`: a
 * built-in error class is that class, so `instanceof` holds as it does over
 * RPC; any other name is an `Error` carrying the name.
 */
export function scriptedError(spec: string): Error {
  const at = spec.indexOf(": ");
  if (at < 0) return new Error(spec);
  const name = spec.slice(0, at);
  const message = spec.slice(at + 2);
  const builtIn = builtInErrors[name];
  if (builtIn) return new builtIn(message);
  const error = new Error(message);
  error.name = name;
  return error;
}

/** The scripted stub a Worker sees under a service binding's name. */
export function proxyService(binding: string, ctx: ProxyContext, script: ServiceSetup): object {
  const target = `Service:${binding}`;
  const point = (op: string, args: JsonValue): EffectPoint => ({
    invocation: ctx.currentInvocation(),
    target,
    op,
    args,
    allowed: writeFaults,
  });
  const unsupported = (what: string): never => {
    const reason = `service binding ${binding}: ${what}`;
    ctx.hooks.unsupported(reason);
    throw new Error(`eutaxy: ${reason}`);
  };
  /** The scripted reply to a method, by name; a method the script lacks cannot be answered. */
  const replyTo = (method: string): ScriptedReply => {
    if (script.methods === undefined) return { returns: null };
    if (!Object.hasOwn(script.methods, method))
      return unsupported(
        `no scripted reply for method ${method}; add it to the service(${JSON.stringify(binding)}) setup's methods`,
      );
    return script.methods[method] as ScriptedReply;
  };
  const answer = (method: string): unknown => {
    const reply = replyTo(method);
    if ("throws" in reply) throw scriptedError(reply.throws);
    // Copied, as RPC copies values: the Worker cannot change the script.
    return structuredClone(reply.returns);
  };

  const fetchThrough = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = parseBody(await request.text());
    const reply = await ctx.hooks.effect(
      point(method, { url: request.url, method, headers, body }),
      async () => {
        // The matcher is the externals'; a service binding takes any host, so none is matched.
        const found = findResponse(
          {
            name: binding,
            host: url.host,
            guarantees: {},
            ...(script.fetch === undefined ? {} : { responses: script.fetch }),
          },
          method,
          url.pathname,
        );
        if (found === undefined)
          return unsupported(
            `no scripted reply for fetch ${method} ${url.pathname}; add it to the service(${JSON.stringify(binding)}) setup's fetch`,
          );
        const reply = replyOf(found);
        // workerd follows a redirect from the callee as fetch does; the script holds only the first reply.
        if (isRedirect(reply.status) && request.redirect !== "manual")
          return unsupported(
            `the scripted reply to ${method} ${url.pathname} is a ${reply.status} redirect, which the runtime would follow; script the final reply or fetch with redirect: "manual"`,
          );
        return reply;
      },
      (r) => ({ status: r.status }),
    );
    return toResponse(reply);
  };

  /**
   * The promise a call returns. On the real stub it is an RPC promise that
   * pipelines property reads (`stub.charge().id`); this one is not, so a read
   * on it makes the run UNSUPPORTED instead of yielding undefined.
   */
  const pipelineGuard = <T>(promise: Promise<T>, method: string): Promise<T> =>
    new Proxy(promise, {
      get(target, prop) {
        if (typeof prop === "symbol" || prop === "then" || prop === "catch" || prop === "finally") {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        ctx.hooks.unsupported(
          `service binding ${binding}: RPC promise pipelining (reading .${prop} on ${method}()'s promise) is not supported; await the call first`,
        );
        return undefined;
      },
    });

  /** One call: `stub.method(...)`, or `await stub.property` (an RPC getter). */
  const call = (method: string) => {
    const invoke = (...args: unknown[]) =>
      pipelineGuard(
        ctx.hooks.effect(
          point(method, { args: args.map((a) => toJson(a)) }),
          async () => answer(method),
          (value) => ({ value: toJson(value) }),
        ),
        method,
      );
    const read = () =>
      ctx.hooks.effect(
        point(method, { property: true }),
        async () => answer(method),
        (value) => ({ value: toJson(value) }),
      );
    const awaitable = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => read().then(onFulfilled, onRejected);
    // Callable and awaitable; any other property read is pipelining, which is not modelled.
    return new Proxy(invoke, {
      get(fn, key) {
        if (key === "then") return awaitable;
        if (typeof key === "symbol") return Reflect.get(fn, key);
        ctx.hooks.unsupported(
          `service binding ${binding}: RPC promise pipelining (reading .${method}.${key}) is not supported; await .${method} first`,
        );
        return undefined;
      },
    });
  };

  return new Proxy(
    {},
    {
      get(_stub, prop) {
        // The stub is not a promise.
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (prop === "fetch") return fetchThrough;
        if (prop === "connect")
          return () => unsupported("connect() (a raw TCP socket) is not modelled");
        return call(prop);
      },
    },
  );
}
