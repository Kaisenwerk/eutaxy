/** Inbound HTTP delivery: one invocation per attempt of a request the drive's caller sends. */

import type { DeliveryResult, EventRef, JsonValue, RunHooks, ScenarioSpec } from "@eutaxy/core";
import { CrashSignal, InjectedEffectError, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import { startCaller } from "./caller.ts";
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

  const handled = await runInvocation(hooks, inv, () =>
    handler.call(worker.handler, requestFor(req), worker.env, executionContext(background)),
  );
  const response = handled.status === "completed" ? handled.value : undefined;
  let status: DeliveryResult["status"] = handled.status;

  let summary: { status: number; ok: boolean } | null = null;
  let read: { status: number; ok: boolean; body: JsonValue } | "crashed" | "errored" = "errored";
  if (status === "completed" && response) {
    // The body is read before the point so the record is complete; the point itself is the send.
    // Streaming bodies run handler code: a crash inside it abandons the read, an error fails the delivery.
    const body = await runInvocation(hooks, inv, () => summarizeResponse(response));
    read =
      body.status === "completed"
        ? (body.value as { status: number; ok: boolean; body: JsonValue })
        : body.status;
    if (read === "crashed" || read === "errored") status = read;
  }
  let late = caller.isLate();
  const allowed = caller.responseFaults;
  if (status === "completed" && typeof read === "object") {
    const s = read;
    try {
      hooks.effectSync(
        { invocation, target, op: "response", args, allowed },
        () => s,
        (v) => v,
      );
      summary = s;
    } catch (err) {
      if (err instanceof CrashSignal) status = "crashed";
      else if (err instanceof InjectedEffectError) {
        // Sent, but after the caller's deadline: the handler carries on, the caller resends.
        summary = s;
        late = true;
      } else throw err;
    }
  } else if (status === "errored") {
    // Cloudflare answers an uncaught exception with a 500 (workers runtime behaviour); the caller sees that.
    const s = { status: 500, ok: false, body: "" };
    hooks.effectSync(
      { invocation, target, op: "response", args, allowed: [] },
      () => s,
      (v) => v,
    );
    summary = s;
  }

  const accepted =
    summary !== null && !late && (drive.retryOn === "5xx" ? summary.status < 500 : summary.ok);
  caller.settle(accepted, late);

  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  return { status, followUps: [] };
}
