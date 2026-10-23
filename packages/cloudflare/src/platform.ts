/**
 * The Cloudflare platform: delivers queue messages to the Worker's `queue()`
 * handler and inbound requests to its `fetch()` handler, with proxied
 * bindings, and applies Queues' at-least-once semantics (explicit and
 * implicit ack, retry, redelivery up to max_retries, dead-lettering) as
 * documented by Cloudflare, and for requests the caller's retry policy
 * declared in the drive.
 */

import type {
  DeliveryResult,
  EventRef,
  FaultKind,
  JsonValue,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal, InjectedEffectError } from "@eutaxy/engine";
import { type ProxyContext, proxyD1, resetD1, snapshotD1 } from "./d1.ts";
import { type HttpDrive, type HttpRequestSpec, type QueueDrive, retryDelayMs } from "./scenario.ts";

const ACK: readonly FaultKind[] = ["crash_before", "crash_after"];
const CUT_OFF: readonly FaultKind[] = ["cut_off"];
/** The response point: a crash before it is a response the caller never saw. */
const RESPOND: readonly FaultKind[] = ["crash_before"];
/**
 * With a caller deadline the answer can also arrive too late: `ambiguous`
 * here means it was sent, the caller counted it as failed, and the handler
 * carried on.
 */
const RESPOND_WITH_DEADLINE: readonly FaultKind[] = ["crash_before", "ambiguous"];

/** The Worker's default export, as far as the platform drives it. */
export interface WorkerHandler {
  queue?(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): void | Promise<void>;
  fetch?(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
}

/** The former name of `WorkerHandler`, kept for callers written against 0.1. */
export type QueueHandler = WorkerHandler;

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

export interface CloudflarePlatformOptions {
  /** The bindings from `cloudflare:workers`. */
  readonly env: object;
  /** The Worker's default export. */
  readonly handler: WorkerHandler;
  /** Schema SQL per D1 binding named in the scenario's setup. */
  readonly schemas: Readonly<Record<string, string>>;
  /** Cloudflare's default when the consumer does not set max_retries. */
  readonly maxRetries?: number;
}

function isD1(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function" &&
    typeof (value as { batch?: unknown }).batch === "function"
  );
}

function isBindingLike(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  const names = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertyNames(proto ?? {})];
  return names.some(
    (k) => k !== "constructor" && typeof (value as Record<string, unknown>)[k] === "function",
  );
}

/** Deep-copy JSON data so a handler that mutates its message cannot leak into other runs. */
function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const assumptions: readonly string[] = [
  "platform model: Cloudflare Queues at-least-once delivery; the first ack or retry decision per message wins; unacked messages are redelivered up to max_retries then dead-lettered",
  "D1 statements run against Miniflare's SQLite; each run/first/all/raw/batch/exec is one effect",
  "message.timestamp is the virtual clock's time at delivery",
  "only D1 bindings are proxied; touching any other binding makes the run UNSUPPORTED",
  "state invariants read a snapshot of every D1 binding named in setup, taken after the last event",
  "work passed to ctx.waitUntil runs after the handler returns and never affects acknowledgement or the response; a cut_off fault at that point loses work not yet started, and an effect in flight commits without its continuation",
  "concurrent invocations (maxConcurrentInvocations above 1) share one isolate's module state and bindings, and another may run while one awaits I/O (developers.cloudflare.com/workers/reference/how-workers-works/); queue consumers run concurrently up to max_concurrency (developers.cloudflare.com/queues/configuration/consumer-concurrency/)",
  "inbound requests: one invocation per attempt; an uncaught exception is a 500 response; the drive's caller resends a request it got no acceptable response for (crash before the response, an answer after its deadlineMs, or a status its retryOn policy rejects) up to its retries, each resend after its delaysMs entry of virtual time; the handler's own time is virtual, so a late answer is the ambiguous fault at the response point or an answer later than deadlineMs in virtual time",
];

export function createCloudflarePlatform(options: CloudflarePlatformOptions): Platform {
  const env = options.env as Record<string, unknown>;
  const maxRetries = options.maxRetries ?? 3;
  let hooksRef: RunHooks | null = null;

  const ctx: ProxyContext = {
    get hooks() {
      if (!hooksRef) throw new Error("no run in progress");
      return hooksRef;
    },
    // Bindings are shared by every invocation in flight; the engine knows which one is running.
    currentInvocation: () => ctx.hooks.running(),
  };

  const d1Proxies = new Map<string, D1Database>();
  const proxiedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string") return value;
      if (isD1(value)) {
        let p = d1Proxies.get(prop);
        if (!p) {
          p = proxyD1(value, prop, ctx);
          d1Proxies.set(prop, p);
        }
        return p;
      }
      if (isBindingLike(value)) ctx.hooks.unsupported(`binding ${prop} is not proxied`);
      return value;
    },
  });

  /** Platform-level actions (dead-lettering) are recorded under an invocation no fault can crash. */
  const platformInvocations = new WeakMap<RunHooks, string>();
  function platformInvocation(hooks: RunHooks): string {
    let id = platformInvocations.get(hooks);
    if (id === undefined) {
      id = "platform";
      hooks.startInvocation(id, { bookkeeping: true });
      platformInvocations.set(hooks, id);
    }
    return id;
  }

  return {
    name: "cloudflare",
    assumptions,
    concurrent: true,

    async reset(spec: ScenarioSpec): Promise<void> {
      for (const step of spec.setup) {
        if (step.kind !== "d1") continue;
        const binding = String(step["binding"]);
        const schema = options.schemas[binding];
        if (schema === undefined) throw new Error(`no schema provided for D1 binding ${binding}`);
        const real = env[binding];
        if (!isD1(real)) throw new Error(`env.${binding} is not a D1 binding`);
        await resetD1(real, schema);
      }
    },

    restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec {
      const drive = spec.drive as QueueDrive | HttpDrive;
      if (drive.kind === "http") {
        return {
          ...spec,
          drive: { ...drive, requests: drive.requests.filter((r) => keepIds.includes(r.id)) },
        };
      }
      return {
        ...spec,
        drive: { ...drive, messages: drive.messages.filter((m) => keepIds.includes(m.id)) },
      };
    },

    async finish(spec: ScenarioSpec, hooks: RunHooks): Promise<void> {
      for (const step of spec.setup) {
        if (step.kind !== "d1") continue;
        const binding = String(step["binding"]);
        const real = env[binding];
        if (!isD1(real)) continue;
        const tables = await snapshotD1(real);
        hooks.snapshot(platformInvocation(hooks), `D1:${binding}`, { tables });
      }
    },

    initialEvents(spec: ScenarioSpec): readonly EventRef[] {
      const drive = spec.drive as QueueDrive | HttpDrive;
      if (drive.kind === "http") {
        return drive.requests.map((r) => ({
          id: r.id,
          attempt: 1,
          data: r as unknown as JsonValue,
        }));
      }
      return drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    },

    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      const drive = spec.drive as QueueDrive | HttpDrive;
      const invocation = `${event.id}#${event.attempt}`;
      hooksRef = hooks;
      return drive.kind === "http"
        ? await deliverRequest(event, hooks, spec, drive, invocation)
        : await deliverMessage(event, hooks, spec, drive, invocation);
    },
  };

  /** The `ExecutionContext` handed to a handler; `waitUntil` work is collected to run after it returns. */
  function executionContext(background: Promise<unknown>[]): ExecutionContext {
    return {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(
          promise.then(
            () => undefined,
            () => undefined,
          ),
        );
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
  }

  /**
   * Background work extends the invocation but never changes the acknowledgement or the response.
   * A cut-off here is the isolate dying after them: work not yet started is lost.
   */
  async function drainBackground(
    hooks: RunHooks,
    inv: { isCrashed(): boolean; readonly crashed: Promise<void> },
    invocation: string,
    target: string,
    background: readonly Promise<unknown>[],
  ): Promise<boolean> {
    if (background.length === 0 || inv.isCrashed()) return false;
    try {
      hooks.effectSync(
        {
          invocation,
          target,
          op: "background",
          args: { pending: background.length },
          allowed: CUT_OFF,
        },
        () => null,
        () => null,
      );
      await Promise.race([hooks.settle(Promise.all(background), invocation), inv.crashed]);
      return false;
    } catch (err) {
      if (!(err instanceof CrashSignal)) throw err;
      return true;
    }
  }

  async function deliverRequest(
    event: EventRef,
    hooks: RunHooks,
    spec: ScenarioSpec,
    drive: HttpDrive,
    invocation: string,
  ): Promise<DeliveryResult> {
    const req = event.data as unknown as HttpRequestSpec;
    const target = `Http:${req.path}`;
    const inv = hooks.startInvocation(invocation);
    // Virtual time: when the caller sent this attempt, for its deadline.
    const started = Date.now();
    const background: Promise<unknown>[] = [];
    const handler = options.handler.fetch;
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
      const redeliveries = event.attempt - 1;
      if (redeliveries < drive.retries && redeliveries < spec.bounds.maxRedeliveries) {
        const resendAt = Math.max(at + retryDelayMs(drive, event.attempt), Date.now());
        hooks.enqueue({
          ...event,
          attempt: event.attempt + 1,
          ...(resendAt > Date.now() ? { at: resendAt } : {}),
        });
      } else {
        hooks.effectSync(
          {
            invocation: platformInvocation(hooks),
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
      deadline === undefined || lateAt === undefined
        ? undefined
        : setTimeout(() => giveUp(lateAt), deadline);

    let response: Response | undefined;
    const outcome = Promise.resolve()
      .then(() =>
        handler.call(options.handler, requestFor(req), proxiedEnv, executionContext(background)),
      )
      .then(
        (r) => {
          response = r;
          return "completed" as const;
        },
        (err: unknown) =>
          err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const),
      );
    let status = await Promise.race([
      hooks.settle(outcome, invocation),
      inv.crashed.then(() => "crashed" as const),
    ]);

    let summary: { status: number; ok: boolean } | null = null;
    let read: { status: number; ok: boolean; body: JsonValue } | "crashed" | "errored" = "errored";
    if (status === "completed" && response) {
      // The body is read before the point so the record is complete; the point itself is the send.
      // Streaming bodies run handler code: a crash inside it abandons the read, an error fails the delivery.
      read = await Promise.race([
        hooks.settle(summarizeResponse(response), invocation).then(
          (s) => s as { status: number; ok: boolean; body: JsonValue },
          (err: unknown) =>
            err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const),
        ),
        inv.crashed.then(() => "crashed" as const),
      ]);
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

  async function deliverMessage(
    event: EventRef,
    hooks: RunHooks,
    spec: ScenarioSpec,
    drive: QueueDrive,
    invocation: string,
  ): Promise<DeliveryResult> {
    {
      const queueTarget = `Queue:${drive.queue}`;
      const inv = hooks.startInvocation(invocation);
      /** Cloudflare honours the first ack or retry decision per message; later ones are ignored. */
      const state: { decision: "ack" | "retry" | null } = { decision: null };
      const background: Promise<unknown>[] = [];

      /** Records the call; the result says whether it took effect (the first decision wins). */
      const decide = (op: "ack" | "retry", args: JsonValue): void => {
        hooks.effectSync(
          { invocation, target: queueTarget, op, args, allowed: ACK },
          () => {
            if (state.decision !== null) return false;
            state.decision = op;
            return true;
          },
          (effective) => ({ effective }),
        );
      };
      const message: Message<unknown> = {
        id: event.id,
        timestamp: new Date(),
        body: cloneJson(event.data),
        attempts: event.attempt,
        ack: () => decide("ack", { messageId: event.id, implicit: false, body: event.data }),
        retry: () => decide("retry", { messageId: event.id, body: event.data }),
      };
      const batch: MessageBatch<unknown> = {
        queue: drive.queue,
        messages: [message],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll: () => message.ack(),
        retryAll: () => message.retry(),
      };
      const execution = executionContext(background);

      const handler = options.handler.queue;
      if (!handler) throw new Error("the Worker has no queue() handler");
      const outcome = Promise.resolve()
        .then(() => handler.call(options.handler, batch, proxiedEnv, execution))
        .then(
          () => "completed" as const,
          (err: unknown) =>
            err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const),
        );
      let status = await Promise.race([
        hooks.settle(outcome, invocation),
        inv.crashed.then(() => "crashed" as const),
      ]);

      if (status === "completed" && state.decision === null) {
        try {
          decide("ack", { messageId: event.id, implicit: true, body: event.data });
        } catch (err) {
          if (err instanceof CrashSignal) status = "crashed";
          else throw err;
        }
      }

      if (await drainBackground(hooks, inv, invocation, queueTarget, background))
        status = "crashed";

      const followUps: EventRef[] = [];
      if (state.decision !== "ack") {
        const redeliveries = event.attempt - 1;
        if (event.attempt <= maxRetries && redeliveries < spec.bounds.maxRedeliveries) {
          followUps.push({ ...event, attempt: event.attempt + 1 });
        } else {
          hooks.effectSync(
            {
              invocation: platformInvocation(hooks),
              target: queueTarget,
              op: "dead_letter",
              args: { messageId: event.id, attempts: event.attempt },
              allowed: [],
            },
            () => null,
            () => null,
          );
        }
      }
      return { status, followUps };
    }
  }
}
