/**
 * A Durable Object namespace with its objects scripted. A caller reaches an
 * object through a stub of its namespace (`env.BINDING.get(id)`,
 * `getByName(name)`), by RPC method or by `fetch()` (Durable Objects, create
 * Durable Object stubs and send requests). Here no object of the namespace
 * is constructed or run: the scenario's `scriptedObject()` setup scripts
 * the replies, as `service()` scripts a Worker, and each call is one effect
 * on `DO:<binding>` with the object's name in its arguments and the faults
 * of a stub call, where `crash_before` and `error` mean the call never
 * reached the object, `ambiguous` that it acted and the answer was lost,
 * and `crash_after` that the caller died after it. Ids are the namespace's
 * own, so an id made here equals the one the runtime would make. The stub
 * is the one a scripted service has (`serviceStub`).
 */

import { type EffectPoint, type JsonValue, toJson, writeFaults } from "@eutaxy/core";
import { findResponse, isRedirect, replyOf, toResponse } from "@eutaxy/engine";
import { outboundGate, type ProxyContext, pointAt, refuse } from "./proxy-context.ts";
import type { ScriptedObjectSetup, ScriptedReply } from "./scenario.ts";
import { recordRequest, scriptedError, serviceStub } from "./services.ts";

/** An RPC argument as effect-log data; a Request becomes its method and URL. */
function argument(value: unknown): JsonValue {
  if (value instanceof Request) return { method: value.method, url: value.url };
  return toJson(value);
}

/** The namespace a caller sees under a scripted Durable Object binding's name. */
export function proxyScriptedNamespace(
  real: DurableObjectNamespace,
  binding: string,
  ctx: ProxyContext,
  script: ScriptedObjectSetup,
): DurableObjectNamespace {
  const target = `DO:${binding}`;
  const setup = `scriptedObject(${JSON.stringify(binding)})`;
  /** Object names by id, so the log names an object as its caller does. */
  const names = new Map<string, string>();
  const nameOf = (id: DurableObjectId): string =>
    names.get(id.toString()) ?? id.name ?? id.toString();
  const point = (op: string, args: JsonValue): EffectPoint =>
    pointAt(ctx, target, op, args, writeFaults);

  function stubFor(id: DurableObjectId): DurableObjectStub {
    const object = nameOf(id);
    const what = `scripted Durable Object ${binding} ${object}`;
    const unsupported = (reason: string): never => refuse(ctx, `${what}: ${reason}`);
    /** The scripted reply to a method, by name; a method the script lacks cannot be answered. */
    const replyTo = (method: string): ScriptedReply => {
      if (script.methods === undefined) return { returns: null };
      if (!Object.hasOwn(script.methods, method))
        return unsupported(
          `no scripted reply for method ${method}; add it to the ${setup} setup's methods`,
        );
      return script.methods[method] as ScriptedReply;
    };
    const answer = (method: string): unknown => {
      const reply = replyTo(method);
      if ("throws" in reply) throw scriptedError(reply.throws);
      // Copied, as RPC copies values: the caller cannot change the script.
      return structuredClone(reply.returns);
    };
    const stub = serviceStub(
      binding,
      ctx,
      {
        call: (method, args) =>
          ctx.hooks.effect(
            point(method, { object, args: args.map(argument) }),
            // From another object the call leaves once that object's earlier writes are durable.
            outboundGate(ctx, async () => answer(method)),
            toJson,
          ),
        property: (method) =>
          ctx.hooks.effect(
            point(method, { object, property: true }),
            outboundGate(ctx, async () => answer(method)),
            toJson,
          ),
        async fetch(request) {
          // Taken where the call starts, before anything is awaited: an object's gate, when one is calling.
          const behind = outboundGate(ctx, async () => undefined);
          const url = new URL(request.url);
          const { method, headers, body } = await recordRequest(request);
          const reply = await ctx.hooks.effect(
            point("fetch", { object, url: request.url, method, headers, body }),
            async () => {
              await behind();
              // The matcher is the externals'; an object takes any host, so none is matched.
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
                  `no scripted reply for fetch ${method} ${url.pathname}; add it to the ${setup} setup's fetch`,
                );
              const reply = replyOf(found);
              // A 101 carries a WebSocket the object accepted; a script has no object to hold its end.
              if (reply.status === 101)
                return unsupported(
                  `the scripted reply to ${method} ${url.pathname} is a 101, and a scripted object accepts no WebSocket`,
                );
              // The runtime follows a redirect an object answers with as fetch does; the script holds only the first reply.
              if (isRedirect(reply.status) && request.redirect !== "manual")
                return unsupported(
                  `the scripted reply to ${method} ${url.pathname} is a ${reply.status} redirect, which the runtime would follow; script the final reply or fetch with redirect: "manual"`,
                );
              return reply;
            },
            (r) => ({ status: r.status, ok: r.status >= 200 && r.status < 300 }),
          );
          return toResponse(reply);
        },
      },
      what,
      { id, name: id.name },
    );
    return stub as DurableObjectStub;
  }

  function idFromName(name: string): DurableObjectId {
    const id = real.idFromName(name);
    names.set(id.toString(), name);
    return id;
  }

  return new Proxy(real, {
    get(namespace, prop, receiver) {
      switch (prop) {
        case "idFromName":
          return idFromName;
        case "idFromString":
          return (hex: string) => namespace.idFromString(hex);
        case "newUniqueId":
          return (options?: DurableObjectNamespaceNewUniqueIdOptions) => {
            if (options?.jurisdiction !== undefined)
              return refuse(
                ctx,
                `${binding}.newUniqueId({ jurisdiction }) is not modelled for a scripted namespace; use newUniqueId() without one`,
              );
            // Natively the id is random. Drawn from the run's random stream it repeats on replay, as a
            // real namespace's does here; the name is the draw.
            return idFromName(`eutaxy:unique:${crypto.randomUUID()}`);
          };
        case "get":
          return (id: DurableObjectId) => stubFor(id);
        case "getByName":
          return (name: string) => stubFor(idFromName(name));
        case "jurisdiction":
          return () =>
            refuse(
              ctx,
              `${binding}.jurisdiction() is not modelled for a scripted namespace; use the namespace itself`,
            );
        default: {
          // Native members check their receiver: read them on the real namespace.
          const value = Reflect.get(namespace, prop, receiver);
          return typeof value === "function" ? value.bind(namespace) : value;
        }
      }
    },
  });
}
