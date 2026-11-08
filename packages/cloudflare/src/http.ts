/** Inbound HTTP delivery: one invocation per attempt of a request the drive's caller sends. */

import type { DeliveryResult, EventRef, JsonValue, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import { type Answer, startCaller } from "./caller.ts";
import type { HttpDrive, HttpRequestSpec } from "./scenario.ts";

/** The URL inbound requests are addressed to; handlers read only the path. */
export const requestOrigin = "https://worker.test";

/** Build the `Request` a drive entry describes. */
export function requestFor(r: HttpRequestSpec): Request {
  const headers = new Headers(r.headers);
  let body: string | null = null;
  if (r.body !== undefined) {
    if (typeof r.body === "string") body = r.body;
    else {
      // Any JSON value, `null` included, travels as application/json.
      body = JSON.stringify(r.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }
  return new Request(`${requestOrigin}${r.path}`, { method: r.method, headers, body });
}

/** A compact record of a response for the effect log: status, ok, and a bounded body. */
export async function summarizeResponse(response: Response): Promise<JsonValue> {
  const text = await response.clone().text();
  let body: JsonValue = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
  if (text && (response.headers.get("content-type") ?? "").includes("json")) {
    try {
      body = JSON.parse(text) as JsonValue;
    } catch {
      // keep the text
    }
  }
  return { status: response.status, ok: response.ok, body };
}

/** One attempt of an inbound request, under the caller's retry policy and deadline. */
export async function deliverRequest(
  event: EventRef,
  hooks: RunHooks,
  spec: ScenarioSpec,
  drive: HttpDrive,
  invocation: string,
  worker: RunningWorker,
): Promise<DeliveryResult> {
  const req = event.data as unknown as HttpRequestSpec;
  const target = `Http:${req.path}`;
  const inv = hooks.startInvocation(invocation);
  const background: Promise<unknown>[] = [];
  const handler = worker.handler.fetch;
  if (!handler) throw new Error("the Worker has no fetch() handler");
  const args: JsonValue = { requestId: event.id, method: req.method, path: req.path };
  const caller = startCaller(event, hooks, spec, drive, target, {
    requestId: event.id,
    attempts: event.attempt,
  });

  const handled = await runInvocation(hooks, inv, async () => {
    const value: unknown = await handler.call(
      worker.handler,
      requestFor(req),
      worker.env,
      executionContext(background),
    );
    // The Workers runtime fails a request whose handler resolves to anything but a Response, as it
    // fails one whose handler throws: the same uncaught error, answered with a 500 below.
    if (!(value instanceof Response))
      throw new TypeError("the fetch handler returned something that is not a Response");
    return value;
  });
  let status: DeliveryResult["status"] = handled.status;
  let answer: Answer = { kind: "none" };
  if (handled.status === "completed") {
    // The body is read before the point so the record is complete; the point itself is the send.
    // Streaming bodies run handler code: a crash inside it abandons the read, an error fails the delivery.
    const body = await runInvocation(hooks, inv, () => summarizeResponse(handled.value));
    if (body.status === "completed") {
      const sent = body.value as { status: number; ok: boolean; body: JsonValue };
      answer = {
        kind: "answered",
        value: sent,
        accepted: drive.retryOn === "5xx" ? sent.status < 500 : sent.ok,
      };
    } else status = body.status;
  }
  // Cloudflare answers an uncaught exception with a 500 (workers runtime behaviour); the caller sees that.
  if (status === "errored")
    answer = { kind: "errored", value: { status: 500, ok: false, body: "" } };
  if (caller.respond(invocation, args, answer)) status = "crashed";

  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  return { status, followUps: [] };
}
