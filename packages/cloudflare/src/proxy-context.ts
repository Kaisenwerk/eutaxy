/**
 * What every binding proxy is given, and the two things each one does with
 * it: name the effect point of a call, and refuse a call the model does not
 * cover while reporting the reason, so the run ends `UNSUPPORTED` rather
 * than guessing.
 */

import type { EffectPoint, FaultKind, JsonValue, RunHooks } from "@eutaxy/core";

export interface ProxyContext {
  readonly hooks: RunHooks;
  /** The invocation currently running; only one runs at a time, even with several in flight. */
  readonly currentInvocation: () => string;
  /** Told when a Durable Object stub's fetch answered 101: the object a WebSocket connection reached, the invocation whose call it was, and the client end. */
  readonly onUpgrade?: (info: {
    binding: string;
    id: string;
    object: string;
    invocation: string;
    client: WebSocket;
  }) => void;
}

/** The effect point of a proxied call: the invocation running now, the binding's target, the call. */
export function pointAt(
  ctx: ProxyContext,
  target: string,
  op: string,
  args: JsonValue,
  allowed: readonly FaultKind[],
): EffectPoint {
  return { invocation: ctx.currentInvocation(), target, op, args, allowed };
}

/** Report why the run cannot be trusted and refuse the call with the same reason. */
export function refuse(ctx: ProxyContext, reason: string): never {
  ctx.hooks.unsupported(reason);
  throw new Error(`eutaxy: ${reason}`);
}
