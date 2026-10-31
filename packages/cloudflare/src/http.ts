/** Inbound HTTP delivery: one invocation per attempt of a request the drive's caller sends. */

import {
  type DeliveryResult,
  type EventRef,
  type FaultKind,
  type JsonValue,
  type RunHooks,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal, InjectedEffectError, runInvocation } from "@eutaxy/engine";
import { drainBackground, executionContext, type RunningWorker } from "./background.ts";
import { type HttpDrive, type HttpRequestSpec, retryDelayMs } from "./scenario.ts";

/** The response point: a crash before it is a response the caller never saw. */
const RESPOND: readonly FaultKind[] = ["crash_before"];
/**
 * With a caller deadline the answer can also arrive too late: `ambiguous`
 * here means it was sent, the caller counted it as failed, and the handler
 * carried on.
 */
const RESPOND_WITH_DEADLINE: readonly FaultKind[] = ["crash_before", "ambiguous"];

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
  // Virtual time: when the caller sent this attempt, for its deadline.
  const started = Date.now();
  const background: Promise<unknown>[] = [];
  const handler = worker.handler.fetch;
  if (!handler) throw new Error("the Worker has no fetch() handler");
  const args: JsonValue = { requestId: event.id, method: req.method, path: req.path };
  const deadline = drive.deadlineMs;
  // The caller gives up at its deadline even when the answer comes later still.
  const lateAt = deadline === undefined ? undefined : started + deadline;

  /** The caller decides once: it accepts the answer, or gives up at `at` and resends or stops. */
  let decided = false;
  const giveUp = (at: number): void => {
    if (decided) return;
    decided = true;
    const next = redelivery(event, drive.retries, spec.bounds);
    if (next) {
      const resendAt = Math.max(at + retryDelayMs(drive, event.attempt), Date.now());
      hooks.enqueue({ ...next, ...(resendAt > Date.now() ? { at: resendAt } : {}) });
    } else {
      hooks.effectSync(
        {
          invocation: hooks.bookkeeping(),
          target,
          op: "gave_up",
          args: { requestId: event.id, attempts: event.attempt },
          allowed: [],
        },
        () => null,
        () => null,
      );
    }
  };
  // A virtual timer: at the deadline the caller gives up, whatever the handler is doing.
  const deadlineTimer =
    lateAt === undefined ? undefined : setTimeout(() => giveUp(lateAt), deadline);

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
  let late = lateAt !== undefined && Date.now() > lateAt;
  const allowed = deadline === undefined ? RESPOND : RESPOND_WITH_DEADLINE;
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

  // The caller decides as soon as it has an answer or gives up, before background work ends.
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  const accepted =
    summary !== null && !late && (drive.retryOn === "5xx" ? summary.status < 500 : summary.ok);
  if (accepted) decided = true;
  else giveUp(late && lateAt !== undefined ? lateAt : Date.now());

  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  return { status, followUps: [] };
}
