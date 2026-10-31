/**
 * Workflows, modelled: the binding's `create`/`get`, and each instance run
 * as invocations of its class's `run(event, step)` against a model of the
 * engine (persisted step results, retries in virtual time, restarts that
 * re-run `run` from the start). The real local engine is never called: it
 * runs on its own real-time clock and retry loop, which Eutaxy can neither
 * fault nor schedule. See docs/design.md, "Workflows".
 */

import {
  type DeliveryResult,
  type EventRef,
  type FaultKind,
  invocationOf,
  type JsonValue,
  type RunHooks,
  toJson,
  writeFaults,
} from "@eutaxy/core";
import {
  CrashSignal,
  InjectedEffectError,
  type Outcome as RunOutcome,
  runInvocation,
} from "@eutaxy/engine";
import { drainBackground, executionContext } from "./background.ts";
import type { ProxyContext } from "./d1.ts";

/** The `EventRef.source` of a Workflow instance's run. */
export const workflowSource = "workflow";

/** Before a step's callback: the engine restarts before the step runs. */
const STEP_START: readonly FaultKind[] = ["crash_before"];
/**
 * After it: the engine restarts after the step ran but before its result
 * was persisted (`crash_after`), or the attempt ran and counted as failed,
 * as a timeout does (`ambiguous`).
 */
const STEP_RESULT: readonly FaultKind[] = ["crash_after", "ambiguous"];

/**
 * Cloudflare's defaults for a step without a config (Workflows, Sleeping
 * and retrying). A partial config is merged with them field by field, as
 * the engine does. Miniflare's local engine waits 1 s by default; the
 * model keeps the documented 10 s.
 */
const defaultRetries = { limit: 5, delay: 10_000, backoff: "exponential" } as const;

/** A persisted step result; a failure is kept as the engine keeps it, serialised (built-in types survive). */
type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface Instance {
  readonly id: string;
  readonly params: unknown;
  readonly createdAt: number;
  status: "queued" | "running" | "complete" | "errored";
  /** What `run` returned, as the engine keeps it; summarised only where it is recorded. */
  output?: unknown;
  error?: { readonly name: string; readonly message: string };
  /** Persisted step and sleep results, by name and count: what a restart replays. */
  readonly persisted: Map<string, Outcome>;
  /** Attempts started per step, persisted as the engine does, so a restart goes on counting. */
  readonly attempts: Map<string, number>;
  /** Each step's config as its first attempt resolved it; a restart reuses it, as the engine does. */
  readonly configs: Map<
    string,
    { readonly retries: ResolvedRetries; readonly timeout: unknown; readonly sensitive?: string }
  >;
  /** Each pending sleep's or retry's deadline, persisted before it waits, so a restart waits only the rest. */
  readonly deadlines: Map<string, number>;
}

/** One binding's instances in the current run. */
export class WorkflowRegistry {
  readonly instances = new Map<string, Instance>();

  clear(): void {
    this.instances.clear();
  }

  /** The instances as rows for the end-of-run snapshot, by id. */
  rows(): JsonValue[] {
    return [...this.instances.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((i) => ({
        id: i.id,
        status: i.status,
        params: toJson(i.params),
        ...(i.output === undefined ? {} : { output: toJson(i.output) }),
        ...(i.error === undefined ? {} : { error: `${i.error.name}: ${i.error.message}` }),
      }));
  }
}

/** A Workflow binding as the env shows it (Miniflare's `WorkflowImpl`). */
export function isWorkflowBinding(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["create"] === "function" &&
    typeof v["createBatch"] === "function" &&
    typeof v["get"] === "function"
  );
}

interface CreateOptions {
  readonly id?: string;
  readonly params?: unknown;
}

/** The binding's proxy: instances live in the registry and run as events, never in the real engine. */
export function proxyWorkflow(
  binding: string,
  ctx: ProxyContext,
  registry: WorkflowRegistry,
): object {
  const target = `Workflow:${binding}`;
  const unsupported = (what: string): never => {
    const reason = `Workflow ${binding}: ${what} is not modelled`;
    ctx.hooks.unsupported(reason);
    throw new Error(`eutaxy: ${reason}`);
  };
  const handle = (id: string): object => ({
    id,
    status: () =>
      ctx.hooks.effect(
        { invocation: ctx.currentInvocation(), target, op: "status", args: { id }, allowed: [] },
        async () => {
          const i = registry.instances.get(id);
          if (!i) throw new Error("instance.not_found");
          return {
            status: i.status,
            // A copy, as the binding's serialised answer is: the caller cannot change the instance.
            // The binding answers null when there is no output yet, or run() returned nothing.
            output: i.output === undefined ? null : structuredClone(i.output),
            ...(i.error === undefined ? {} : { error: { ...i.error } }),
          };
        },
        (s) => toJson(s),
      ),
    pause: () => unsupported("pause()"),
    resume: () => unsupported("resume()"),
    terminate: () => unsupported("terminate()"),
    restart: () => unsupported("restart()"),
    sendEvent: () => unsupported("sendEvent()"),
    delete: () => unsupported("delete()"),
    subscribe: () => unsupported("subscribe()"),
  });
  return {
    async create(options: CreateOptions = {}) {
      // Generated with the run's virtual randomness, before the call, as the binding does locally.
      const id = options.id ?? crypto.randomUUID();
      // The binding's own default (Miniflare): no params is an empty object; null stays null.
      const params = structuredClone(options.params === undefined ? {} : options.params);
      return ctx.hooks.effect(
        {
          invocation: ctx.currentInvocation(),
          target,
          op: "create",
          args: { id, params: toJson(params) },
          // A call to the engine: it may never arrive, or arrive with its answer lost.
          allowed: writeFaults,
        },
        async () => {
          if (!validInstanceId(id)) throw new Error("Workflow instance has invalid id");
          if (registry.instances.has(id))
            throw new Error(
              `(instance.already_exists) Workflow instance with id "${id}" already exists`,
            );
          registry.instances.set(id, {
            id,
            params,
            createdAt: Date.now(),
            status: "queued",
            persisted: new Map(),
            attempts: new Map(),
            configs: new Map(),
            deadlines: new Map(),
          });
          ctx.hooks.enqueue({
            id: `workflow:${binding}:${id}`,
            attempt: 1,
            source: workflowSource,
            data: { binding, id },
          });
          return handle(id);
        },
        () => ({ id }),
      );
    },
    async get(id: string) {
      return ctx.hooks.effect(
        { invocation: ctx.currentInvocation(), target, op: "get", args: { id }, allowed: [] },
        async () => {
          if (!registry.instances.has(id)) throw new Error("instance.not_found");
          return handle(id);
        },
        () => ({ id }),
      );
    },
    createBatch: () => unsupported("createBatch()"),
    deleteBatch: () => unsupported("deleteBatch()"),
  };
}

/** The binding's rule for an instance id (Miniflare): up to 100 of these characters. */
function validInstanceId(id: unknown): boolean {
  return typeof id === "string" && id.length <= 100 && /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/.test(id);
}

/** Sets `ctx` and `env` as `WorkflowEntrypoint` does, for the one `new` workerd would refuse. */
class StandInEntrypoint {
  readonly ctx: unknown;
  readonly env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Construct a `WorkflowEntrypoint` subclass outside the runtime. workerd's
 * base constructor accepts only a native ExecutionContext, so for this one
 * synchronous `new` the class that extends it directly extends a stand-in
 * instead; its own constructor and field initialisers run as written, and
 * the base is put back before anything else can run.
 */
export function constructWorkflow(cls: unknown, ctx: unknown, env: unknown): object {
  if (typeof cls !== "function") throw new TypeError("not a class");
  let direct = cls as object;
  for (;;) {
    const parent = Object.getPrototypeOf(direct) as unknown;
    if (typeof parent !== "function" || parent === Function.prototype)
      throw new TypeError(`${(cls as { name: string }).name} does not extend WorkflowEntrypoint`);
    if ((parent as { name: string }).name === "WorkflowEntrypoint") break;
    direct = parent;
  }
  const base = Object.getPrototypeOf(direct) as object;
  Object.setPrototypeOf(direct, StandInEntrypoint);
  try {
    return Reflect.construct(cls as new (...a: unknown[]) => object, [ctx, env]);
  } finally {
    Object.setPrototypeOf(direct, base);
  }
}

/** The engine's conversion (itty-time): a year is 365.25 days, a month 30; an unknown unit counts 1. */
const units: { readonly [unit: string]: number } = {
  year: 31_557_600_000,
  month: 2_592_000_000,
  week: 604_800_000,
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1000,
  m: 1,
};

/** The engine's reading of a duration, NaN where it reads none. */
function engineDuration(d: unknown): number {
  if (!Number.isNaN(Number(d)) && typeof d !== "object") return Number(d);
  if (typeof d !== "string") return Number.NaN;
  const m = /^([^ ]+) +(\w\w*?)s?$/.exec(d);
  if (!m) return Number.NaN;
  return Number(m[1]) * (units[m[2] as string] ?? 1);
}

/** A Workflows duration in milliseconds, read as the engine reads it. */
export function durationMs(d: unknown): number {
  const ms = engineDuration(d);
  if (Number.isNaN(ms) || ms < 0) throw new TypeError(`not a Workflows duration: ${String(d)}`);
  return ms;
}

/** Miniflare's `isValidStepConfig`, exactly: its schema is strict, and a timeout `== 0` is refused. */
export function validStepConfig(config: unknown): boolean {
  const only = (o: object, keys: readonly string[]) =>
    Object.keys(o).every((k) => keys.includes(k));
  const durationOk = (v: unknown) => !Number.isNaN(engineDuration(v));
  if (
    typeof config !== "object" ||
    config === null ||
    !only(config, ["retries", "timeout", "sensitive"])
  )
    return false;
  const c = config as Record<string, unknown>;
  const r = c["retries"] as Record<string, unknown> | undefined;
  if (r !== undefined) {
    if (typeof r !== "object" || r === null || !only(r, ["delay", "limit", "backoff"]))
      return false;
    const delay = r["delay"];
    if (
      !(
        typeof delay === "function" ||
        typeof delay === "string" ||
        (typeof delay === "number" && delay >= 0)
      )
    )
      return false;
    if (typeof r["limit"] !== "number" || r["limit"] < 0) return false;
    if (
      r["backoff"] !== undefined &&
      !["constant", "linear", "exponential"].includes(r["backoff"] as string)
    )
      return false;
    if (typeof delay !== "function" && !durationOk(delay)) return false;
  }
  const t = c["timeout"];
  if (t !== undefined) {
    if (!(typeof t === "string" || (typeof t === "number" && t >= 0))) return false;
    // biome-ignore lint/suspicious/noDoubleEquals: the engine's own loose test ("0" and "" are zero)
    if (t == 0 || !durationOk(t)) return false;
  }
  if (c["sensitive"] !== undefined && c["sensitive"] !== "output") return false;
  return true;
}

const utf8 = new TextEncoder();

/** About how many bytes a value takes stored, walking it as structured cloning does. */
function approximateBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 1;
  switch (typeof value) {
    case "string":
      return utf8.encode(value).length;
    case "number":
    case "bigint":
      return 8;
    case "boolean":
      return 1;
    case "object":
      break;
    default:
      return 0;
  }
  const o = value as object;
  if (seen.has(o)) return 0;
  seen.add(o);
  if (o instanceof ArrayBuffer || ArrayBuffer.isView(o)) return o.byteLength;
  if (o instanceof Date) return 8;
  let total = 0;
  if (o instanceof Map)
    for (const [k, v] of o) total += approximateBytes(k, seen) + approximateBytes(v, seen);
  else if (o instanceof Set) for (const v of o) total += approximateBytes(v, seen);
  else
    for (const [k, v] of Object.entries(o))
      total += utf8.encode(k).length + approximateBytes(v, seen);
  return total;
}

function sleep(ms: number): Promise<void> {
  // The virtual setTimeout: the run fires it when the invocation is idle.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ResolvedRetries {
  readonly limit: number;
  readonly delay: unknown;
  readonly backoff?: string;
}

interface StepConfig {
  readonly retries?: { readonly limit: number; readonly delay: unknown; readonly backoff?: string };
  readonly timeout?: unknown;
  /** "output": the step's output is redacted in the engine's logs, here in the trace. */
  readonly sensitive?: string;
}

interface RunDelivery {
  readonly binding: string;
  /** The Workflow's configured name, for `event.workflowName`. */
  readonly name?: string;
  readonly instance: Instance;
  readonly cls: unknown;
  /** The env the instance sees: the proxied bindings. */
  readonly env: object;
  readonly maxFaultsPerRun: number;
  readonly maxRedeliveries: number;
}

/**
 * One engine attempt of an instance: construct its class and call `run`.
 * Steps whose results were persisted return them without running; a crash
 * restarts the instance (a new attempt, from the start of `run`).
 */
export async function deliverWorkflow(
  event: EventRef,
  hooks: RunHooks,
  d: RunDelivery,
): Promise<DeliveryResult> {
  const invocation = invocationOf(event);
  const inv = hooks.startInvocation(invocation);
  const target = `Workflow:${d.binding}`;
  const instance = d.instance;
  instance.status = "running";
  const background: Promise<unknown>[] = [];
  const counts = new Map<string, number>();
  const key = (kind: string, name: string): string => {
    const count = (counts.get(`${kind}:${name}`) ?? 0) + 1;
    counts.set(`${kind}:${name}`, count);
    return `${kind}:${name}#${count}`;
  };
  const replay = (o: Outcome): unknown => {
    if (o.ok) return structuredClone(o.value);
    throw structuredClone(o.error);
  };

  const step = {
    do: async (name: string, a: unknown, b?: unknown, c?: unknown): Promise<unknown> => {
      const [config, fn, options] = (typeof a === "function" ? [{}, a, b] : [a ?? {}, b, c]) as [
        StepConfig,
        (ctx: unknown) => unknown,
        { rollback?: unknown } | undefined,
      ];
      if (options?.rollback !== undefined) {
        hooks.unsupported(`Workflow ${d.binding}: rollback handlers are not modelled`);
        throw new Error("eutaxy: rollback handlers are not modelled");
      }
      // The engine's checks, before anything runs: fatal errors there, whose catching is not documented.
      const fatal = (message: string): never => {
        hooks.unsupported(`Workflow ${d.binding}: ${message}`);
        const err = new Error(message);
        err.name = "WorkflowFatalError";
        throw err;
      };
      if (name.length > 256 || [...name].some((c) => c.charCodeAt(0) < 0x20))
        fatal(`Step name "${name}" exceeds max length (256 chars) or invalid characters found`);
      if (!validStepConfig(config))
        fatal(
          `Step config for "${name}" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/`,
        );
      const k = key("do", name);
      const count = counts.get(`do:${name}`) as number;
      const done = instance.persisted.get(k);
      if (done) return replay(done);
      const live = { ...defaultRetries, ...config.retries };
      const first = instance.configs.get(k);
      if (!first)
        instance.configs.set(k, {
          retries: live,
          timeout: config.timeout ?? "10 minutes",
          ...(config.sensitive === undefined ? {} : { sensitive: config.sensitive }),
        });
      const sensitive = first ? first.sensitive : config.sensitive;
      const stored = first?.retries;
      // A delay function is not persisted: the engine calls the one the current run passes, or
      // falls back to the default delay; the crashed run's function is never called again.
      const retries =
        stored && typeof stored.delay === "function"
          ? {
              ...stored,
              delay: typeof live.delay === "function" ? live.delay : defaultRetries.delay,
            }
          : (stored ?? live);
      const limit = Math.min(retries.limit, d.maxRedeliveries);
      // What the callback sees: a delay function is not exposed (Workflows, Step context).
      const { delay, ...shown } = retries;
      const resolved = {
        retries: typeof delay === "function" ? shown : retries,
        timeout: first ? first.timeout : (config.timeout ?? "10 minutes"),
        ...(sensitive === undefined ? {} : { sensitive }),
      };
      for (let attempt = (instance.attempts.get(k) ?? 0) + 1; ; attempt++) {
        // A retry the engine was waiting for when it restarted: only the rest of its delay.
        const due = instance.deadlines.get(`retry:${k}`);
        if (due !== undefined) {
          await sleep(Math.max(0, due - Date.now()));
          instance.deadlines.delete(`retry:${k}`);
        }
        // A fresh copy per attempt: what the callback does to it does not reach the engine's own.
        const stepContext = {
          step: { name, count },
          attempt,
          config: { ...resolved, retries: { ...resolved.retries } },
        };
        const args = { instance: instance.id, step: name, count, attempt };
        // The callback runs as the instance's own code, between two points: its effects are ordinary
        // effects of the invocation, and its timers are virtual. The points are asynchronous, as the
        // engine's reading and persisting are: other events may run between steps.
        await hooks.effect(
          { invocation, target, op: "step", args, allowed: STEP_START },
          async () => null,
          () => null,
        );
        instance.attempts.set(k, attempt);
        // What the attempt threw, kept as thrown (a plain value too), as the engine rethrows it.
        let failed = false;
        let thrown: unknown;
        let value: unknown;
        let returned: { readonly value: unknown } | undefined;
        try {
          returned = { value: await fn(stepContext) };
        } catch (err) {
          // A crash ends the attempt and the instance; it is not a failure to retry.
          if (err instanceof CrashSignal || inv.isCrashed()) throw err;
          failed = true;
          thrown = err;
          try {
            hooks.effectSync(
              { invocation, target, op: "step_result", args, allowed: [] },
              () => {
                throw err;
              },
              () => null,
            );
          } catch {
            // Recorded as the attempt's error; handled below.
          }
        }
        if (returned !== undefined) {
          const notModelled = (reason: string): never => {
            hooks.unsupported(`Workflow ${d.binding}: step "${name}" ${reason}`);
            throw new Error(`eutaxy: step "${name}" ${reason}`);
          };
          try {
            value = structuredClone(returned.value);
          } catch {
            // A stream, or anything else the engine persists in its own way: not a failure to retry.
            notModelled(
              "returned a value that is not structured-cloneable (a ReadableStream is not modelled)",
            );
          }
          if (approximateBytes(value) > 1_048_576)
            notModelled(
              'returned more than about 1 MiB, which the engine refuses ("output is too large"); Eutaxy cannot measure the stored size exactly',
            );
        }
        if (!failed) {
          try {
            await hooks.effect(
              { invocation, target, op: "step_result", args, allowed: STEP_RESULT },
              async () => value,
              (v) => ({ output: sensitive === "output" ? "[REDACTED]" : toJson(v) }),
            );
            instance.persisted.set(k, { ok: true, value });
            return structuredClone(value);
          } catch (err) {
            if (err instanceof CrashSignal || !(err instanceof InjectedEffectError)) throw err;
            // The attempt ran but counted as failed: a timeout, as the engine reports one.
            thrown = Object.assign(
              new Error(`Execution timed out after ${durationMs(resolved.timeout)}ms`),
              { name: "WorkflowTimeoutError" },
            );
          }
        }
        // The engine's predicate (an Error so named, or whose message starts so). It rethrows the
        // value as thrown and does not persist it, so after a restart the callback runs again.
        if (
          thrown instanceof Error &&
          (thrown.name === "NonRetryableError" || thrown.message.startsWith("NonRetryableError"))
        )
          throw thrown;
        if (attempt > limit) {
          let kept: unknown;
          try {
            kept = structuredClone(thrown);
          } catch {
            kept = new Error(String(thrown));
          }
          instance.persisted.set(k, { ok: false, error: kept });
          throw thrown;
        }
        let wait: number;
        try {
          // A fresh context from the engine's own values: the callback may have changed its copy.
          const delayContext = {
            step: { name, count },
            attempt,
            config: { ...resolved, retries: { ...resolved.retries } },
          };
          wait = await retryDelayMs(retries, attempt, delayContext, thrown);
        } catch (err) {
          hooks.unsupported(
            `Workflow ${d.binding}: step "${name}"'s retry delay function threw (${String(err)})`,
          );
          throw err;
        }
        instance.deadlines.set(`retry:${k}`, Date.now() + wait);
        await sleep(wait);
        instance.deadlines.delete(`retry:${k}`);
      }
    },
    sleep: async (name: string, duration: unknown): Promise<void> => {
      const ms = durationMs(duration);
      // Keyed by name and duration, as the engine keys sleeps: another duration is another sleep.
      await sleepStep(key("sleep", `${name}\u0000${ms}`), name, ms);
    },
    sleepUntil: async (name: string, timestamp: unknown): Promise<void> => {
      const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
      const k = key("sleepUntil", `${name}\u0000${at}`);
      if (instance.persisted.has(k)) {
        // Miniflare's engine checks the time before its cache and throws here; production is undocumented.
        if (at < Date.now())
          hooks.unsupported(
            `Workflow ${d.binding}: step.sleepUntil "${name}" replayed after its time, where Miniflare's engine throws`,
          );
        return;
      }
      // Miniflare's engine refuses a time in the past, with this message.
      if (at < Date.now() && !instance.deadlines.has(k))
        throw new Error("You can't sleep until a time in the past, time-traveler");
      await sleepStep(k, name, Math.max(0, at - Date.now()), at);
    },
    waitForEvent: () => {
      hooks.unsupported(`Workflow ${d.binding}: step.waitForEvent is not modelled`);
      throw new Error("eutaxy: step.waitForEvent is not modelled");
    },
  };
  async function sleepStep(k: string, name: string, ms: number, until?: number): Promise<void> {
    if (instance.persisted.has(k)) return;
    const pending = instance.deadlines.get(k);
    if (pending !== undefined) {
      await sleep(Math.max(0, pending - Date.now()));
      instance.persisted.set(k, { ok: true, value: null });
      return;
    }
    instance.deadlines.set(k, Date.now() + ms);
    hooks.effectSync(
      {
        invocation,
        target,
        op: "sleep",
        args: { instance: instance.id, step: name, ms, ...(until === undefined ? {} : { until }) },
        allowed: [],
      },
      () => null,
      () => null,
    );
    await sleep(ms);
    instance.persisted.set(k, { ok: true, value: null });
  }

  const ran = await runInvocation(hooks, inv, () => {
    const flow = constructWorkflow(d.cls, executionContext(background), d.env) as {
      run(event: unknown, step: unknown): unknown;
    };
    const workflowEvent: Record<string, unknown> = {
      payload: structuredClone(instance.params),
      timestamp: new Date(instance.createdAt),
      instanceId: instance.id,
    };
    if (d.name !== undefined) workflowEvent["workflowName"] = d.name;
    else
      Object.defineProperty(workflowEvent, "workflowName", {
        enumerable: true,
        get: () => {
          hooks.unsupported(
            `Workflow ${d.binding}: event.workflowName needs the Workflow's name, workflow(binding, className, { name })`,
          );
          return undefined;
        },
      });
    return flow.run(workflowEvent, step);
  });
  // The engine keeps the result serialised: one it cannot keep fails the instance.
  const serialised = (value: unknown): RunOutcome<unknown> => {
    try {
      return { status: "completed", value: structuredClone(value) };
    } catch {
      hooks.unsupported(
        `Workflow ${d.binding}: run() returned a value that is not structured-cloneable`,
      );
      return {
        status: "errored",
        error: new Error("run() returned a value that is not structured-cloneable"),
      };
    }
  };
  const result = ran.status === "completed" ? serialised(ran.value) : ran;
  let status = result.status;
  if (result.status === "completed") {
    instance.status = "complete";
    instance.output = result.value;
    hooks.effectSync(
      {
        invocation,
        target,
        op: "complete",
        args: { instance: instance.id, output: toJson(instance.output) },
        allowed: [],
      },
      () => null,
      () => null,
    );
  } else if (result.status === "errored") {
    instance.status = "errored";
    const e = result.error;
    instance.error =
      e instanceof Error
        ? { name: e.name, message: e.message }
        : { name: "Error", message: String(e) };
    hooks.effectSync(
      {
        invocation,
        target,
        op: "errored",
        args: { instance: instance.id, error: `${instance.error.name}: ${instance.error.message}` },
        allowed: [],
      },
      () => null,
      () => null,
    );
  }
  if (await drainBackground(hooks, inv, invocation, target, background)) status = "crashed";
  // The engine restarts a crashed instance from the start of `run`; crashes come from faults, so few.
  const followUps =
    status === "crashed" && instance.status === "running" && event.attempt <= d.maxFaultsPerRun
      ? [{ ...event, attempt: event.attempt + 1 }]
      : [];
  return { status, followUps };
}

/** The delay before the next attempt (Workflows, Sleeping and retrying; a delay function is called). */
async function retryDelayMs(
  retries: NonNullable<StepConfig["retries"]>,
  attempt: number,
  ctx: unknown,
  error: unknown,
): Promise<number> {
  const delay =
    typeof retries.delay === "function"
      ? await (retries.delay as (i: unknown) => unknown)({ ctx, error })
      : retries.delay;
  // The backoff applies to a delay function's value too, as in Miniflare's engine.
  const base = durationMs(delay);
  switch (retries.backoff) {
    case "linear":
      return base * attempt;
    case "exponential":
      return base * 2 ** (attempt - 1);
    default:
      return base;
  }
}
