/**
 * Inbound RPC delivery: one invocation per attempt of a `WorkerEntrypoint`
 * method call the drive's caller makes. The entrypoint is constructed anew
 * for each call, as the runtime does (Cloudflare, Workers RPC: a new
 * instance of the class for every call), and its return value or the error
 * it threw is the response the caller sees.
 */

import {
  type DeliveryResult,
  type EventRef,
  type JsonValue,
  type RunHooks,
  type ScenarioSpec,
  toJson,
} from "@eutaxy/core";
import { CrashSignal, InjectedEffectError, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext } from "./background.ts";
import { startCaller } from "./caller.ts";
import { isPlainData } from "./durable-objects.ts";
import { constructEntrypoint } from "./entrypoint.ts";
import { type RpcCallSpec, type RpcDrive, rpcTarget } from "./scenario.ts";

/**
 * An error as the caller sees it over RPC: a new error object with the
 * name and message (Cloudflare, RPC error handling), nothing of its class.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : JSON.stringify(toJson(error));
}

/** One attempt of a call, under the caller's retry policy and deadline. */
export async function deliverCall(
  event: EventRef,
  hooks: RunHooks,
  spec: ScenarioSpec,
  drive: RpcDrive,
  invocation: string,
  cls: unknown,
  env: object,
): Promise<DeliveryResult> {
  const call = event.data as unknown as RpcCallSpec;
  const target = rpcTarget(drive, call.method);
  const inv = hooks.startInvocation(invocation);
  const background: Promise<unknown>[] = [];
  const args: JsonValue = { callId: event.id, method: call.method, args: call.args };
  const caller = startCaller(event, hooks, spec, drive, target, {
    callId: event.id,
    attempts: event.attempt,
  });

  const ran = await runInvocation(hooks, inv, () =>
    callMethod(cls, call, executionContext(background), env),
  );
  let status: DeliveryResult["status"] = ran.status;
  let late = caller.isLate();
  let answer: { readonly ok: boolean } | null = null;
  if (ran.status === "completed") {
    // Data travels by copy; a stub, a function or a stream would let later calls bypass the run.
    if (!isPlainData(ran.value))
      hooks.unsupported(
        `Rpc ${call.method}: the result is not plain data (a stub, a function or a stream); RPC capabilities are not modelled`,
      );
    const s = { ok: true, value: toJson(ran.value) };
    try {
      hooks.effectSync(
        { invocation, target, op: "response", args, allowed: caller.responseFaults },
        () => s,
        (v) => v,
      );
      answer = s;
    } catch (err) {
      if (err instanceof CrashSignal) status = "crashed";
      else if (err instanceof InjectedEffectError) {
        // Answered, but after the caller's deadline: the handler carries on, the caller resends.
        answer = s;
        late = true;
      } else throw err;
    }
  } else if (ran.status === "errored") {
    // The exception reaches the caller as a new error with its name and message; the caller saw an answer.
    const s = { ok: false, error: describeError(ran.error) };
    hooks.effectSync(
      { invocation, target, op: "response", args, allowed: [] },
      () => s,
      (v) => v,
    );
    answer = s;
  }

  caller.settle(answer !== null && !late && answer.ok, late);
  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  return { status, followUps: [] };
}

/**
 * The class an RPC drive calls: the named export, or the Worker's default
 * export (the class passed as the handler, or `exports.default`). Not
 * necessarily a class: the platform reports what it found instead.
 */
export function entrypointClass(
  handler: unknown,
  exports: Readonly<Record<string, unknown>> | undefined,
  entrypoint: string | undefined,
): unknown {
  if (entrypoint !== undefined) return exports?.[entrypoint];
  return typeof handler === "function" ? handler : exports?.["default"];
}

/**
 * The method RPC exposes under a name: one the class or a superclass defines
 * on its prototype. An instance property, even a function, and Object's own
 * methods are not callable (workerd: "The RPC receiver does not implement the
 * method").
 */
function rpcMethod(instance: object, name: string): ((...a: unknown[]) => unknown) | undefined {
  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    const own = Object.getOwnPropertyDescriptor(proto, name);
    if (!own) continue;
    return typeof own.value === "function" && name !== "constructor"
      ? (own.value as (...a: unknown[]) => unknown)
      : undefined;
  }
  return undefined;
}

/**
 * Construct the entrypoint for one call and invoke the method, as the
 * runtime does per call. The arguments are copied, as RPC copies them: a
 * method that mutates one changes neither the scenario nor a later attempt.
 */
export function callMethod(cls: unknown, call: RpcCallSpec, ctx: unknown, env: object): unknown {
  const instance = constructEntrypoint(cls, "WorkerEntrypoint", ctx, env);
  const method = rpcMethod(instance, call.method);
  if (!method)
    throw new TypeError(`The RPC receiver does not implement the method "${call.method}".`);
  return method.apply(instance, structuredClone(call.args) as unknown[]);
}
