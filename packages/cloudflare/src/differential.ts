/**
 * Differential check: the same fault-free scenario run once through Eutaxy's
 * proxies and once against the raw bindings, with the queue model (or the
 * HTTP caller's retry policy) applied on the raw side itself. Any difference in the per-attempt decisions or in
 * the final D1 and R2 state is a bug in the proxies or the platform model, not in
 * the Worker. The raw side shares Eutaxy's *reading* of Cloudflare's queue
 * semantics (core's redelivery rule among it); what it does not share is any proxy code.
 */

import {
  type EventRef,
  getPath,
  invocationOf,
  type JsonValue,
  redelivery,
  type ScenarioSpec,
} from "@eutaxy/core";
import {
  CrashSignal,
  compareSides,
  DifferentialStuck,
  effectLatencyMs,
  installScriptedFetch,
  patchGlobals,
  proxiedSide,
  settleOn,
  type VirtualClock,
} from "@eutaxy/engine";
import { executionContext } from "./background.ts";
import { isD1, resetD1, snapshotD1 } from "./d1.ts";
import { requestFor } from "./http.ts";
import { type CloudflarePlatformOptions, createCloudflarePlatform } from "./platform.ts";
import { isR2, resetR2, snapshotR2 } from "./r2.ts";
import type { HttpDrive, HttpRequestSpec, QueueDrive, R2Setup } from "./scenario.ts";

/** A type, not an interface, so it is JSON data the comparison takes as it is. */
export type AttemptRecord = {
  readonly event: string;
  readonly attempt: number;
  readonly status: "completed" | "errored";
  /** Queue drive: the acknowledgement that took effect. */
  readonly decision: "ack" | "retry" | null;
  /** HTTP drive: the response status the caller saw (500 for an uncaught exception). */
  readonly response?: number;
};

export interface Side {
  readonly attempts: readonly AttemptRecord[];
  readonly state: {
    readonly [binding: string]: { readonly [table: string]: readonly JsonValue[] };
  };
}

export interface DifferentialResult {
  /** True only when both sides agree and the proxied run touched nothing unmodelled. */
  readonly equal: boolean;
  readonly eutaxy: Side;
  readonly raw: Side;
  readonly differences: readonly string[];
  /** What the proxied run could not control; non-empty means the comparison proves nothing. */
  readonly unsupported: readonly string[];
}

/**
 * The raw side's only wrapper: counts D1 calls in flight (so the settle loop
 * knows real I/O is pending) and advances the clock as the proxies do. It
 * records nothing and injects nothing.
 */
function countingD1(real: D1Database, io: { n: number }, clock: VirtualClock): D1Database {
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const track = async <T>(p: Promise<T>): Promise<T> => {
    io.n++;
    try {
      return await p;
    } finally {
      io.n--;
      clock.advance(effectLatencyMs);
    }
  };
  const wrapStatement = (s: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(s, {
      get(t, prop, r) {
        const v = Reflect.get(t, prop, r) as unknown;
        if (prop === "bind") return (...a: unknown[]) => wrapStatement(t.bind(...a));
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return (...a: unknown[]) =>
            track((v as (...x: unknown[]) => Promise<unknown>).apply(t, a));
        }
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    realOf.set(proxy, s);
    return proxy;
  };
  return new Proxy(real, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r) as unknown;
      if (prop === "prepare") return (sql: string) => wrapStatement(t.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) =>
          track(t.batch(stmts.map((s) => realOf.get(s) ?? s)));
      }
      if (prop === "exec") return (sql: string) => track(t.exec(sql));
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/**
 * The same for an R2 bucket: each call advances the clock as its proxied
 * effect does, and reading a body it gave counts as I/O in flight but does
 * not advance the clock (the proxy reads it inside the get). Reads through
 * the body's own stream are not counted: wrapping it would lose the known
 * length a copy's put needs, and Miniflare answers them within the settle
 * loop's real tick (checked with an 8 MB body).
 */
function countingR2(real: R2Bucket, io: { n: number }, clock: VirtualClock): R2Bucket {
  const track = async <T>(p: Promise<T>, advance: boolean): Promise<T> => {
    io.n++;
    try {
      return await p;
    } finally {
      io.n--;
      if (advance) clock.advance(effectLatencyMs);
    }
  };
  const reads = ["arrayBuffer", "bytes", "text", "json", "blob"];
  const counted = (o: unknown): unknown => {
    if (o === null || typeof o !== "object" || !("body" in o)) return o;
    return new Proxy(o, {
      get(t, prop) {
        // The object's own getters (body, etag) need the object itself as receiver.
        const v = Reflect.get(t, prop) as unknown;
        if (typeof prop === "string" && reads.includes(prop) && typeof v === "function")
          return (...a: unknown[]) =>
            track((v as (...x: unknown[]) => Promise<unknown>).apply(t, a), false);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  };
  return new Proxy(real, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r) as unknown;
      if (
        prop === "put" ||
        prop === "delete" ||
        prop === "get" ||
        prop === "head" ||
        prop === "list"
      )
        return async (...a: unknown[]) =>
          counted(await track((v as (...x: unknown[]) => Promise<unknown>).apply(t, a), true));
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}

async function snapshotAll(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<Side["state"]> {
  const env = options.env as Record<string, unknown>;
  const out: Record<string, { readonly [table: string]: readonly JsonValue[] }> = {};
  for (const step of spec.setup) {
    if (step.kind === "r2") {
      const binding = (step as R2Setup).binding;
      const real = env[binding];
      if (isR2(real)) out[binding] = { objects: await snapshotR2(real) };
      continue;
    }
    if (step.kind !== "d1") continue;
    const binding = String(step["binding"]);
    const real = env[binding];
    if (isD1(real)) out[binding] = await snapshotD1(real);
  }
  return out;
}

/** The Eutaxy side, keeping each delivery's status and the decision it made. */
async function eutaxySide(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<Side & { readonly unsupported: readonly string[] }> {
  const { attempts, unsupported } = await proxiedSide(
    spec,
    createCloudflarePlatform(options),
    (event, result, entries): AttemptRecord => {
      const invocation = invocationOf(event);
      const mine = entries.filter((e) => e.invocation === invocation);
      const decision = mine.find(
        (e) =>
          e.kind === "result" &&
          (e.op === "ack" || e.op === "retry") &&
          getPath(e.payload, "result.effective") === true,
      )?.op as "ack" | "retry" | undefined;
      const response = mine.find((e) => e.kind === "result" && e.op === "response");
      return {
        event: event.id,
        attempt: event.attempt,
        status: result.status === "completed" ? "completed" : "errored",
        decision: decision ?? null,
        ...(response ? { response: getPath(response.payload, "result.status") as number } : {}),
      };
    },
  );
  return { attempts, state: await snapshotAll(spec, options), unsupported };
}

/** Each binding's tables under `<binding>.<table>`, as the comparison names them. */
function flatten(state: Side["state"]): { readonly [name: string]: readonly JsonValue[] } {
  const out: Record<string, readonly JsonValue[]> = {};
  for (const [binding, tables] of Object.entries(state))
    for (const [table, rows] of Object.entries(tables)) out[`${binding}.${table}`] = rows;
  return out;
}

/** The raw side: the handler called directly with the real bindings and plain message or Request objects. */
async function rawSide(spec: ScenarioSpec, options: CloudflarePlatformOptions): Promise<Side> {
  const env = options.env as Record<string, unknown>;
  const drive = spec.drive as QueueDrive | HttpDrive;
  const maxRetries = options.maxRetries ?? 3;
  for (const step of spec.setup) {
    if (step.kind === "r2") {
      const setup = step as R2Setup;
      const real = env[setup.binding];
      if (isR2(real)) await resetR2(real, setup.objects);
      continue;
    }
    if (step.kind !== "d1") continue;
    const binding = String(step["binding"]);
    const schema = options.schemas[binding];
    const real = env[binding];
    if (schema !== undefined && isD1(real)) await resetD1(real, schema);
  }
  const attempts: AttemptRecord[] = [];
  const pending: EventRef[] =
    drive.kind === "http"
      ? drive.requests.map((r) => ({ id: r.id, attempt: 1, data: r as unknown as JsonValue }))
      : drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
  // The same virtual globals as the proxied side, from the same seed, so Date.now and randomness agree,
  // and the same scripted externals, without recording.
  const patched = patchGlobals(0);
  const unsupported: string[] = [];
  const restoreFetch = installScriptedFetch(
    spec.externals,
    null,
    (r) => unsupported.push(r),
    () => patched.clock.advance(effectLatencyMs), // the proxied side advances per effect; match it
  );
  const io = { n: 0 };
  const counting = new Map<string, D1Database | R2Bucket>();
  const countedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || !(isD1(value) || isR2(value))) return value;
      let c = counting.get(prop);
      if (!c) {
        c = isD1(value)
          ? countingD1(value, io, patched.clock)
          : countingR2(value, io, patched.clock);
        counting.set(prop, c);
      }
      return c;
    },
  });
  const settle = <T>(p: Promise<T>): Promise<T> =>
    settleOn(p, {
      clock: patched.clock,
      inFlight: () => io.n,
      crashed: () => false,
      stuck: () => {
        throw new DifferentialStuck();
      },
    });
  try {
    if (drive.kind === "http") {
      const handler = options.handler.fetch;
      if (!handler) throw new Error("the Worker has no fetch() handler");
      while (pending.length > 0) {
        const event = pending.shift() as EventRef;
        const req = event.data as unknown as HttpRequestSpec;
        const background: Promise<unknown>[] = [];
        let status: "completed" | "errored";
        let response = 500;
        try {
          const r = await settle(
            Promise.resolve().then(() =>
              handler.call(
                options.handler,
                requestFor(req),
                countedEnv,
                executionContext(background),
              ),
            ),
          );
          await settle(r.clone().text());
          response = r.status;
          status = "completed";
        } catch (err) {
          if (err instanceof CrashSignal || err instanceof DifferentialStuck) throw err;
          status = "errored";
        }
        await settle(Promise.all(background));
        attempts.push({
          event: event.id,
          attempt: event.attempt,
          status,
          decision: null,
          response,
        });
        const accepted =
          drive.retryOn === "5xx" ? response < 500 : response >= 200 && response < 300;
        const next = accepted ? null : redelivery(event, drive.retries, spec.bounds);
        if (next) pending.push(next);
      }
    } else {
      const handler = options.handler.queue;
      if (!handler) throw new Error("the Worker has no queue() handler");
      while (pending.length > 0) {
        const event = pending.shift() as EventRef;
        let decision: "ack" | "retry" | null = null;
        const background: Promise<unknown>[] = [];
        const message: Message<unknown> = {
          id: event.id,
          timestamp: new Date(),
          body: JSON.parse(JSON.stringify(event.data)) as JsonValue,
          attempts: event.attempt,
          ack: () => {
            decision ??= "ack";
          },
          retry: () => {
            decision ??= "retry";
          },
        };
        const batch: MessageBatch<unknown> = {
          queue: drive.queue,
          messages: [message],
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          ackAll: () => message.ack(),
          retryAll: () => message.retry(),
        };
        const ctx = executionContext(background);
        let status: "completed" | "errored";
        try {
          await settle(
            Promise.resolve().then(() => handler.call(options.handler, batch, countedEnv, ctx)),
          );
          status = "completed";
        } catch (err) {
          if (err instanceof CrashSignal || err instanceof DifferentialStuck) throw err;
          status = "errored";
        }
        if (status === "completed") decision ??= "ack";
        await settle(Promise.all(background));
        attempts.push({ event: event.id, attempt: event.attempt, status, decision });
        const next = decision === "ack" ? null : redelivery(event, maxRetries, spec.bounds);
        if (next) pending.push(next);
      }
    }
  } finally {
    restoreFetch();
    patched.restore();
  }
  if (unsupported.length > 0) throw new DifferentialStuck(`raw side: ${unsupported.join("; ")}`);
  return { attempts, state: await snapshotAll(spec, options) };
}

/** Run both sides and compare. The Eutaxy side runs first; both start from the schema. */
export async function runDifferential(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<DifferentialResult> {
  if (spec.drive.kind === "http" && ("delaysMs" in spec.drive || "deadlineMs" in spec.drive)) {
    throw new Error("runDifferential does not model the caller's delaysMs or deadlineMs yet");
  }
  const { unsupported, ...eutaxy } = await eutaxySide(spec, options);
  const raw = await rawSide(spec, options);
  const differences = compareSides(
    { attempts: eutaxy.attempts, state: flatten(eutaxy.state) },
    { attempts: raw.attempts, state: flatten(raw.state) },
    unsupported,
  );
  return { equal: differences.length === 0, eutaxy, raw, differences, unsupported };
}
