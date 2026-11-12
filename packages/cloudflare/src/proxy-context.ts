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
  /** The Worker's env as the platform proxies it: what an object's own service bindings answer from. */
  readonly env?: () => object;
  /**
   * An object's output gate, for the call it is making right now: set by the
   * object's own env around the synchronous start of a call through a
   * binding, and taken by that binding's stub (`outboundGate`) to wait on
   * inside the effect, before the call is performed.
   */
  readonly gate?: { pending: (() => Promise<void>) | undefined };
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

/**
 * What performing a call must wait on first, when an object is making it:
 * the object's writes before the call, durable, as the runtime's output gate
 * holds an outgoing message until they are. Taken where the stub's call
 * starts, synchronously; the wait runs inside the effect, as its real I/O,
 * so a fault that keeps the call from leaving does not make the writes
 * durable and one that lands after it finds them kept.
 */
export function outboundGate<T>(ctx: ProxyContext, perform: () => Promise<T>): () => Promise<T> {
  // Taken, not read: the slot is empty again before the effect is made. A crash fault on that
  // effect resets the object with `abort()`, which ends its code without running a `finally`, and a
  // gate left in the slot would be the next call's, anywhere, to wait on: another object's storage.
  const gate = ctx.gate?.pending;
  if (ctx.gate) ctx.gate.pending = undefined;
  return gate
    ? async () => {
        await gate();
        return perform();
      }
    : perform;
}

/** Report why the run cannot be trusted and refuse the call with the same reason. */
export function refuse(ctx: ProxyContext, reason: string): never {
  ctx.hooks.unsupported(reason);
  throw new Error(`eutaxy: ${reason}`);
}
