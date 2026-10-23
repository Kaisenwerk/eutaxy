/**
 * Differential check: the same fault-free scenario run once through Eutaxy's
 * proxies and once against the raw bindings, with the queue model (or the
 * HTTP caller's retry policy) applied by hand on the raw side. Any difference in the per-attempt decisions or in
 * the final D1 state is a bug in the proxies or the platform model, not in
 * the Worker. The raw side shares Eutaxy's *reading* of Cloudflare's queue
 * semantics; what it does not share is any proxy code.
 */

import {
  canonicalJson,
  type EventRef,
  getPath,
  type JsonValue,
  type ScenarioSpec,
} from "@eutaxy/core";
import {
  CrashSignal,
  effectLatencyMs,
  installScriptedFetch,
  patchGlobals,
  Run,
  settleOn,
  type VirtualClock,
} from "@eutaxy/engine";
import { resetD1, snapshotD1 } from "./d1.ts";
import {
  type CloudflarePlatformOptions,
  createCloudflarePlatform,
  requestFor,
} from "./platform.ts";
import type { HttpDrive, HttpRequestSpec, QueueDrive } from "./scenario.ts";

export interface AttemptRecord {
  readonly event: string;
  readonly attempt: number;
  readonly status: "completed" | "errored";
  /** Queue drive: the acknowledgement that took effect. */
  readonly decision: "ack" | "retry" | null;
  /** HTTP drive: the response status the caller saw (500 for an uncaught exception). */
  readonly response?: number;
}

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

/** The raw side cannot abandon an invocation the way the engine does; a stuck handler ends the comparison. */
class StuckError extends Error {
  override readonly name = "StuckError";
  constructor(
    message = "the handler is waiting on something outside the run (no timer due, no effect in flight)",
  ) {
    super(message);
  }
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

function isD1(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

async function snapshotAll(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<Side["state"]> {
  const env = options.env as Record<string, unknown>;
  const out: Record<string, { readonly [table: string]: readonly JsonValue[] }> = {};
  for (const step of spec.setup) {
    if (step.kind !== "d1") continue;
    const binding = String(step["binding"]);
    const real = env[binding];
    if (isD1(real)) out[binding] = await snapshotD1(real);
  }
  return out;
}

/** The Eutaxy side: one run with no faults, driven like `runOnce` but keeping each delivery's status. */
async function eutaxySide(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<Side & { readonly unsupported: readonly string[] }> {
  const platform = createCloudflarePlatform(options);
  const run = new Run({
    mode: "replay",
    schedule: { seed: 0, faults: [] },
    // The comparison delivers one event at a time on both sides, whatever the scenario's bound.
    bounds: { ...spec.bounds, maxConcurrentInvocations: 1 },
    faultProbability: 0,
  });
  const attempts: AttemptRecord[] = [];
  await platform.reset(spec);
  run.install(spec.externals);
  try {
    const pending: EventRef[] = [...platform.initialEvents(spec)];
    while (pending.length > 0) {
      const event = pending.shift() as EventRef;
      const invocation = `${event.id}#${event.attempt}`;
      const before = run.log.entries.length;
      const result = await platform.deliver(event, run, spec);
      const mine = run.log.entries.slice(before).filter((e) => e.invocation === invocation);
      const decision = mine.find(
        (e) =>
          e.kind === "result" &&
          (e.op === "ack" || e.op === "retry") &&
          getPath(e.payload, "result.effective") === true,
      )?.op as "ack" | "retry" | undefined;
      const response = mine.find((e) => e.kind === "result" && e.op === "response");
      attempts.push({
        event: event.id,
        attempt: event.attempt,
        status: result.status === "completed" ? "completed" : "errored",
        decision: decision ?? null,
        ...(response ? { response: getPath(response.payload, "result.status") as number } : {}),
      });
      pending.push(...result.followUps);
    }
  } finally {
    run.uninstall();
  }
  await platform.finish?.(spec, run);
  return { attempts, state: await snapshotAll(spec, options), unsupported: run.unsupportedReasons };
}

/** The raw side: the handler called directly with the real bindings and plain message or Request objects. */
async function rawSide(spec: ScenarioSpec, options: CloudflarePlatformOptions): Promise<Side> {
  const env = options.env as Record<string, unknown>;
  const drive = spec.drive as QueueDrive | HttpDrive;
  const maxRetries = options.maxRetries ?? 3;
  for (const step of spec.setup) {
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
  const counting = new Map<string, D1Database>();
  const countedEnv = new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || !isD1(value)) return value;
      let c = counting.get(prop);
      if (!c) {
        c = countingD1(value, io, patched.clock);
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
        throw new StuckError();
      },
    });
  const ctxFor = (background: Promise<unknown>[]) =>
    ({
      waitUntil: (p: Promise<unknown>) => {
        background.push(
          p.then(
            () => undefined,
            () => undefined,
          ),
        );
      },
      passThroughOnException: () => {},
      props: {},
    }) as unknown as ExecutionContext;
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
              handler.call(options.handler, requestFor(req), countedEnv, ctxFor(background)),
            ),
          );
          await settle(r.clone().text());
          response = r.status;
          status = "completed";
        } catch (err) {
          if (err instanceof CrashSignal || err instanceof StuckError) throw err;
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
        if (
          !accepted &&
          event.attempt - 1 < drive.retries &&
          event.attempt - 1 < spec.bounds.maxRedeliveries
        ) {
          pending.push({ ...event, attempt: event.attempt + 1 });
        }
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
        const ctx = ctxFor(background);
        let status: "completed" | "errored";
        try {
          await settle(
            Promise.resolve().then(() => handler.call(options.handler, batch, countedEnv, ctx)),
          );
          status = "completed";
        } catch (err) {
          if (err instanceof CrashSignal || err instanceof StuckError) throw err;
          status = "errored";
        }
        if (status === "completed") decision ??= "ack";
        await settle(Promise.all(background));
        attempts.push({ event: event.id, attempt: event.attempt, status, decision });
        if (
          decision !== "ack" &&
          event.attempt <= maxRetries &&
          event.attempt - 1 < spec.bounds.maxRedeliveries
        ) {
          pending.push({ ...event, attempt: event.attempt + 1 });
        }
      }
    }
  } finally {
    restoreFetch();
    patched.restore();
  }
  if (unsupported.length > 0) throw new StuckError(`raw side: ${unsupported.join("; ")}`);
  return { attempts, state: await snapshotAll(spec, options) };
}

/** Run both sides and compare. The Eutaxy side runs first; both start from the schema. */
export async function runDifferential(
  spec: ScenarioSpec,
  options: CloudflarePlatformOptions,
): Promise<DifferentialResult> {
  const { unsupported, ...eutaxy } = await eutaxySide(spec, options);
  const raw = await rawSide(spec, options);
  const differences: string[] = [];
  if (unsupported.length > 0) {
    differences.push(`the proxied run touched unsupported APIs: ${unsupported.join("; ")}`);
  }
  const a = canonicalJson(eutaxy.attempts as unknown as JsonValue);
  const b = canonicalJson(raw.attempts as unknown as JsonValue);
  if (a !== b) differences.push(`attempts differ:\n  eutaxy ${a}\n  raw    ${b}`);
  const bindings = new Set([...Object.keys(eutaxy.state), ...Object.keys(raw.state)]);
  for (const binding of [...bindings].sort()) {
    const tables = new Set([
      ...Object.keys(eutaxy.state[binding] ?? {}),
      ...Object.keys(raw.state[binding] ?? {}),
    ]);
    for (const table of [...tables].sort()) {
      const x = canonicalJson((eutaxy.state[binding]?.[table] ?? []) as unknown as JsonValue);
      const y = canonicalJson((raw.state[binding]?.[table] ?? []) as unknown as JsonValue);
      if (x !== y) differences.push(`${binding}.${table} differs:\n  eutaxy ${x}\n  raw    ${y}`);
    }
  }
  return { equal: differences.length === 0, eutaxy, raw, differences, unsupported };
}
