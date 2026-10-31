/**
 * Typed construction of scenario specs for Cloudflare Workers. Everything here
 * produces the plain-data `ScenarioSpec` from core; this module only knows the
 * Cloudflare shapes (queues, D1 bindings) and the effect conventions the
 * proxies follow.
 */

import {
  type AtLeastOnce,
  type Bounds,
  atLeastOncePerMessage as coreAtLeastOncePerMessage,
  defaultBounds,
  type EffectSelector,
  type EventRef,
  type EveryRow,
  type ExternalDecl,
  type Implies,
  type Invariant,
  type JsonValue,
  type PlatformData,
  type References,
  type Refines,
  type RowCondition,
  type ScenarioSpec,
  type ScriptedResponse,
  type StateQuery,
  type Unique,
  validateScenario,
  type WorkerRef,
} from "@eutaxy/core";
import { virtualEpoch } from "@eutaxy/engine";
import { cronTicks, parseCron } from "./cron.ts";
import type { R2Seed } from "./r2.ts";

/** One queue message to deliver; `id` defaults to its position. */
export interface QueueMessage {
  readonly id?: string;
  readonly body: JsonValue;
}

/** Drive the Worker's `queue()` handler with these messages. */
export interface QueueDrive extends PlatformData {
  readonly kind: "queue";
  readonly queue: string;
  readonly messages: readonly { readonly id: string; readonly body: JsonValue }[];
}

/** One inbound request; `id` defaults to its position, `method` to POST with a body and GET without. */
export interface HttpRequestInput {
  readonly id?: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: { readonly [name: string]: string };
  /** JSON body (sent as application/json) or a string body. */
  readonly body?: JsonValue;
}

/** A type alias, not an interface, so it is assignable to the JSON shape of `PlatformData`. */
export type HttpRequestSpec = {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: { readonly [name: string]: string };
  /** Absent: no body at all. `null` is a JSON body, sent as `null`. */
  readonly body?: JsonValue;
};

/**
 * Drive the Worker's `fetch()` handler with these requests. The caller's
 * retry policy decides redelivery: a webhook provider resends a request it
 * got no 2xx for (`retryOn: "non-2xx"`, the default) or only on 5xx and
 * failures (`"5xx"`), up to `retries` times; a browser-like caller has
 * `retries: 0`. `delaysMs[i]` is the virtual time the caller waits before
 * its resend number i + 1 (the last entry repeats; none means at once).
 * `deadlineMs` is how long the caller waits for an answer: one that comes
 * later counts as failed and is resent while the handler may still run.
 */
export interface HttpDrive extends PlatformData {
  readonly kind: "http";
  readonly requests: readonly HttpRequestSpec[];
  readonly retries: number;
  readonly retryOn: "non-2xx" | "5xx";
  readonly delaysMs?: readonly number[];
  readonly deadlineMs?: number;
}

export interface HttpCallerOptions {
  readonly retries?: number;
  readonly retryOn?: "non-2xx" | "5xx";
  readonly delaysMs?: readonly number[];
  readonly deadlineMs?: number;
}

export function http(
  requests: readonly HttpRequestInput[],
  options: HttpCallerOptions = {},
): HttpDrive {
  return {
    kind: "http",
    requests: requests.map((r, i) => ({
      id: r.id ?? `req-${i + 1}`,
      method: (r.method ?? (r.body === undefined ? "GET" : "POST")).toUpperCase(),
      path: r.path,
      headers: r.headers ?? {},
      ...(r.body === undefined ? {} : { body: r.body }),
    })),
    retries: options.retries ?? 3,
    retryOn: options.retryOn ?? "non-2xx",
    ...(options.delaysMs === undefined ? {} : { delaysMs: [...options.delaysMs] }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  };
}

/** One RPC call; `id` defaults to its position, `args` to none. */
export interface RpcCallInput {
  readonly id?: string;
  readonly method: string;
  readonly args?: readonly JsonValue[];
}

/** A type alias, not an interface, so it is assignable to the JSON shape of `PlatformData`. */
export type RpcCallSpec = {
  readonly id: string;
  readonly method: string;
  readonly args: readonly JsonValue[];
};

/**
 * Drive a `WorkerEntrypoint` of the Worker with these method calls, one
 * invocation per attempt, the entrypoint constructed anew for each. The
 * entrypoint is the Worker's default export, or the named export
 * `entrypoint`. Cloudflare does not retry an RPC call; the caller resends
 * a call that threw or got no answer up to `retries` times (default 0: a
 * calling Worker resends only when written to), after `delaysMs` of
 * virtual time, and gives up waiting at `deadlineMs`, as the HTTP drive's
 * caller does.
 */
export interface RpcDrive extends PlatformData {
  readonly kind: "rpc";
  readonly entrypoint?: string;
  readonly calls: readonly RpcCallSpec[];
  readonly retries: number;
  readonly delaysMs?: readonly number[];
  readonly deadlineMs?: number;
}

export interface RpcCallerOptions {
  readonly entrypoint?: string;
  readonly retries?: number;
  readonly delaysMs?: readonly number[];
  readonly deadlineMs?: number;
}

export function rpc(calls: readonly RpcCallInput[], options: RpcCallerOptions = {}): RpcDrive {
  return {
    kind: "rpc",
    ...(options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint }),
    calls: calls.map((c, i) => ({
      id: c.id ?? `call-${i + 1}`,
      method: c.method,
      args: [...(c.args ?? [])],
    })),
    retries: options.retries ?? 0,
    ...(options.delaysMs === undefined ? {} : { delaysMs: [...options.delaysMs] }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  };
}

/** The target of a call's effects: the method, under the entrypoint's name when the drive names one. */
export function rpcTarget(drive: Pick<RpcDrive, "entrypoint">, method: string): string {
  return `Rpc:${drive.entrypoint === undefined ? method : `${drive.entrypoint}.${method}`}`;
}

/** One tick of a Cron Trigger: its id and the virtual time it fires, which the handler sees as `scheduledTime`. */
export type CronTickSpec = { readonly id: string; readonly at: number };

/**
 * Drive the Worker's `scheduled()` handler with the ticks of a Cron Trigger:
 * the expression's first `ticks` matches from the virtual epoch on, in UTC,
 * each an event delivered at its virtual time. Cloudflare documents
 * `noRetry()` but no retry count, so the drive declares how many times a
 * tick whose handler failed is re-run (`retries`, default 0); a handler that
 * called `noRetry()` is not re-run.
 */
export interface CronDrive extends PlatformData {
  readonly kind: "cron";
  readonly cron: string;
  readonly ticks: readonly CronTickSpec[];
  readonly retries: number;
}

export interface CronOptions {
  /** How many ticks to drive, from the first match on (default 1). */
  readonly ticks?: number;
  readonly retries?: number;
}

export function cron(expression: string, options: CronOptions = {}): CronDrive {
  const count = options.ticks ?? 1;
  const times =
    Number.isInteger(count) && count >= 1 ? cronTicks(expression, virtualEpoch, count) : [];
  return {
    kind: "cron",
    cron: expression,
    ticks: times.map((at, i) => ({ id: `tick-${i + 1}`, at })),
    retries: options.retries ?? 0,
  };
}

/** The drives a Cloudflare scenario can have. */
export type Drive = QueueDrive | HttpDrive | RpcDrive | CronDrive;

/** The drive's events as they are first delivered: one per message, request or call, attempt 1. */
export function driveEvents(drive: Drive): readonly EventRef[] {
  switch (drive.kind) {
    case "queue":
      return drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    case "http":
      return drive.requests.map((r) => ({ id: r.id, attempt: 1, data: r as unknown as JsonValue }));
    case "rpc":
      return drive.calls.map((c) => ({ id: c.id, attempt: 1, data: c as unknown as JsonValue }));
    case "cron":
      // Delivered at its virtual time: the clock moves there once nothing else can.
      return drive.ticks.map((t) => ({
        id: t.id,
        attempt: 1,
        data: { cron: drive.cron, scheduledTime: t.at },
        at: t.at,
      }));
  }
}

/** The drive with only the named events kept, for shrinking. */
export function restrictDrive(drive: Drive, keepIds: readonly string[]): Drive {
  const keep = (id: string): boolean => keepIds.includes(id);
  switch (drive.kind) {
    case "queue":
      return { ...drive, messages: drive.messages.filter((m) => keep(m.id)) };
    case "http":
      return { ...drive, requests: drive.requests.filter((r) => keep(r.id)) };
    case "rpc":
      return { ...drive, calls: drive.calls.filter((c) => keep(c.id)) };
    case "cron":
      return { ...drive, ticks: drive.ticks.filter((t) => keep(t.id)) };
  }
}

/** Apply a SQL file to a D1 binding before each run. */
export interface D1Setup extends PlatformData {
  readonly kind: "d1";
  readonly binding: string;
  readonly schemaFile: string;
}

/**
 * Clear a Durable Object namespace before each run and seed the named
 * objects' storage with these entries; its storage is snapshotted after the
 * run for state invariants (see `durableObjectRows`).
 */
export interface DurableObjectSetup extends PlatformData {
  readonly kind: "durable_object";
  readonly binding: string;
  readonly objects: { readonly [name: string]: { readonly [key: string]: JsonValue } };
  /**
   * How many times each object's alarm may fire in one run (retries not
   * counted); an object that keeps re-arming stops there. Default 3.
   */
  readonly alarmsPerObject?: number;
}

export function durableObject(
  binding: string,
  objects: { readonly [name: string]: { readonly [key: string]: JsonValue } } = {},
  options: { readonly alarmsPerObject?: number } = {},
): DurableObjectSetup {
  return {
    kind: "durable_object",
    binding,
    objects,
    ...(options.alarmsPerObject === undefined ? {} : { alarmsPerObject: options.alarmsPerObject }),
  };
}

/** An R2 bucket the scenario uses: emptied, then seeded with these objects, before each run. */
export interface R2Setup extends PlatformData {
  readonly kind: "r2";
  readonly binding: string;
  readonly objects: Readonly<Record<string, R2Seed>>;
}

export function r2Bucket(binding: string, objects: Readonly<Record<string, R2Seed>> = {}): R2Setup {
  return { kind: "r2", binding, objects };
}

/**
 * Selects an R2 bucket's operations that completed, a `put` by default; a
 * put whose `onlyIf` failed stored nothing and is not selected, as a D1
 * write that changed no row is not.
 */
export function r2Op(
  binding: string,
  op: "put" | "delete" | "get" | "head" | "list" = "put",
): EffectSelector {
  const target = `R2:${binding}`;
  return op === "put"
    ? { target, op, kind: "result", where: { "result.stored": true } }
    : { target, op, kind: "result" };
}

/** A bucket's objects at the end of the run as rows `{ key, size, etag, customMetadata, httpMetadata, text? }`. */
export function r2Rows(binding: string, where?: readonly RowCondition[]): StateQuery {
  const target = `R2:${binding}`;
  return where ? { target, table: "objects", where } : { target, table: "objects" };
}

/**
 * Every row the query returns is named by some row of `in` (its `column`
 * equals the row's value at `path`), as with a foreign key.
 */
export function references(
  name: string,
  query: StateQuery,
  path: string,
  inQuery: StateQuery,
  column: string,
): References {
  return { kind: "references", name, query, path, in: inQuery, column };
}

/** A Workflow binding, and the class (an export of the Worker module) its instances run. */
export interface WorkflowSetup extends PlatformData {
  readonly kind: "workflow";
  readonly binding: string;
  readonly className: string;
  /** The Workflow's `name` in the wrangler config, which instances see as `event.workflowName`. */
  readonly name?: string;
}

export function workflow(
  binding: string,
  className: string,
  options: { readonly name?: string } = {},
): WorkflowSetup {
  return {
    kind: "workflow",
    binding,
    className,
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

/** A scripted method's reply: a value returned to the caller, or an error (`"<Name>: <message>"`) thrown to it. */
export type ScriptedReply = { readonly returns: JsonValue } | { readonly throws: string };

/** A reply to `fetch()` through a service binding; a type alias of core's `ScriptedResponse`, for the JSON shape. */
export type ServiceResponse = {
  readonly method?: string;
  readonly path?: string;
  readonly status: number;
  readonly headers?: { readonly [name: string]: string };
  readonly body?: JsonValue;
};

/**
 * Script the Worker another Worker reaches through a service binding: its
 * RPC methods answer from `methods` (every method returns `null` when
 * omitted; a method missing from a present `methods` makes the run
 * UNSUPPORTED) and its `fetch()` from `fetch`, matched by method and path
 * as an external's responses are (200 with an empty body when omitted).
 * The real binding is never called. Each call is one effect,
 * `Service:<binding>`, with the faults of a Durable Object stub call.
 */
export interface ServiceSetup extends PlatformData {
  readonly kind: "service";
  readonly binding: string;
  readonly methods?: { readonly [method: string]: ScriptedReply };
  readonly fetch?: readonly ServiceResponse[];
}

export function service(
  binding: string,
  options: {
    readonly methods?: { readonly [method: string]: ScriptedReply };
    readonly fetch?: readonly ServiceResponse[];
  } = {},
): ServiceSetup {
  return {
    kind: "service",
    binding,
    ...(options.methods === undefined ? {} : { methods: options.methods }),
    ...(options.fetch === undefined ? {} : { fetch: [...options.fetch] }),
  };
}

/** Selects the calls through a service binding that completed, one method's or all. */
export function serviceCall(binding: string, method?: string): EffectSelector {
  return {
    target: `Service:${binding}`,
    ...(method === undefined ? {} : { op: method }),
    kind: "result",
  };
}

/** Selects a Workflow's step attempts, optionally of one step; a failed attempt's result carries its error. */
export function workflowStep(binding: string, step?: string): EffectSelector {
  return {
    target: `Workflow:${binding}`,
    op: "step_result",
    kind: "result",
    ...(step === undefined ? {} : { where: { "args.step": step } }),
  };
}

/** A Workflow's instances at the end of the run as rows `{ id, status, params, output?, error? }`. */
export function workflowRows(binding: string, where?: readonly RowCondition[]): StateQuery {
  const target = `Workflow:${binding}`;
  return where ? { target, table: "instances", where } : { target, table: "instances" };
}

/** Alarm firings per object per run when the setup does not say. */
export const defaultAlarmsPerObject = 3;

/**
 * The storage of one object (by the name its id was made from) as rows
 * `{ key, value }`, for state invariants.
 */
export function durableObjectRows(
  binding: string,
  object: string,
  where?: readonly RowCondition[],
): StateQuery {
  const target = `DO:${binding}`;
  return where ? { target, table: object, where } : { target, table: object };
}

export interface CloudflareScenarioInput {
  readonly name: string;
  readonly worker: WorkerRef;
  readonly drive:
    | QueueDrive
    | HttpDrive
    | RpcDrive
    | CronDrive
    | {
        readonly kind: "queue";
        readonly queue: string;
        readonly messages: readonly QueueMessage[];
      };
  readonly setup?: readonly (
    | D1Setup
    | DurableObjectSetup
    | R2Setup
    | WorkflowSetup
    | ServiceSetup
  )[];
  readonly externals?: readonly ExternalDecl[];
  readonly invariants: readonly Invariant[];
  readonly bounds?: Partial<Bounds>;
  /** Modules of pure core functions with spec files beside them, relative to the scenario (see ScenarioSpec.specs). */
  readonly specs?: readonly string[];
}

export function queue(name: string, messages: readonly QueueMessage[]): QueueDrive {
  return {
    kind: "queue",
    queue: name,
    messages: messages.map((m, i) => ({ id: m.id ?? `msg-${i + 1}`, body: m.body })),
  };
}

export function d1Schema(binding: string, schemaFile: string): D1Setup {
  return { kind: "d1", binding, schemaFile };
}

/**
 * Effect conventions for D1 (what the proxies record):
 *   call   payload { args: { sql, params } }
 *   result payload { args: { sql, params }, result: { changes, lastRowId } }
 * A committed write is a `result` whose `result.changes` is at least 1.
 */
export function d1Write(binding: string, op: "run" | "batch" = "run"): EffectSelector {
  return { target: `D1:${binding}`, op, kind: "result", atLeast: { "result.changes": 1 } };
}

/** Reads of a D1 binding: `first` (result payload `{ row }`), `all` or `raw`. */
export function d1Read(binding: string, op: "first" | "all" | "raw" = "first"): EffectSelector {
  return { target: `D1:${binding}`, op, kind: "result" };
}

/** Dot path to the Nth bound parameter of a D1 statement, in an effect payload. */
export function d1Param(index: number): string {
  return `args.params.${index}`;
}

/**
 * The shell follows the core function `decision` (see the `refines`
 * invariant): every selected effect carries out the latest decision of its
 * invocation, agrees with it on `follows`, and, with `state`, was not made
 * stale by another invocation's write between the read it rests on and the
 * effect. The core function's module must be listed in the scenario's
 * `specs`, which is what records its calls.
 */
export function refines(
  name: string,
  decision: string,
  effect: EffectSelector,
  options: Pick<Refines, "follows" | "state"> = {},
): Refines {
  return { kind: "refines", name, decision, effect, ...options };
}

/**
 * Every message's (or request's, or call's) `bodyKey` value must appear at
 * least once as `key` in a selected effect: nothing the drive delivered may
 * be lost. For an RPC drive `bodyKey` is a path into the call's arguments
 * (`"0.orderId"`).
 */
export function atLeastOncePerMessage(
  name: string,
  drive: Drive,
  effect: EffectSelector,
  key: string,
  bodyKey: string,
): AtLeastOnce {
  if (drive.kind === "queue")
    return coreAtLeastOncePerMessage(name, drive.messages, effect, key, bodyKey);
  if (drive.kind === "cron") {
    const ticks = drive.ticks.map((t) => ({
      id: t.id,
      body: { cron: drive.cron, scheduledTime: t.at },
    }));
    return coreAtLeastOncePerMessage(name, ticks, effect, key, bodyKey);
  }
  if (drive.kind === "rpc") {
    const calls = drive.calls.map((c) => ({ id: c.id, body: c.args }));
    const inv = coreAtLeastOncePerMessage(name, calls, effect, key, bodyKey);
    // An RPC event's data is the whole call, so the path to re-derive from starts at its arguments.
    return { ...inv, perMessage: { bodyKey: bodyKey === "" ? "args" : `args.${bodyKey}` } };
  }
  const requests = drive.requests.map((r) => ({ id: r.id, body: r.body ?? null }));
  const inv = coreAtLeastOncePerMessage(name, requests, effect, key, bodyKey);
  // An HTTP event's data is the whole request, so the path to re-derive from starts at its body.
  return { ...inv, perMessage: { bodyKey: bodyKey === "" ? "body" : `body.${bodyKey}` } };
}

/**
 * Selects the responses the Worker returned for a path (`ok` narrows to 2xx
 * or to everything else). One `result` per attempt: a crash before the
 * response leaves none, a thrown error records status 500.
 */
export function httpResponse(
  path: string,
  options: { readonly ok?: boolean } = {},
): EffectSelector {
  return {
    target: `Http:${path}`,
    op: "response",
    kind: "result",
    ...(options.ok === undefined ? {} : { where: { "result.ok": options.ok } }),
  };
}

/**
 * Selects the answers an RPC method gave (`ok` narrows to values returned
 * or to errors thrown). One `result` per attempt: a crash before the
 * response leaves none.
 */
export function rpcResponse(
  method: string,
  options: { readonly ok?: boolean; readonly entrypoint?: string } = {},
): EffectSelector {
  return {
    target: rpcTarget(options, method),
    op: "response",
    kind: "result",
    ...(options.ok === undefined ? {} : { where: { "result.ok": options.ok } }),
  };
}

/** Rows of a D1 table in the end-of-run snapshot, optionally filtered. */
export function d1Rows(
  binding: string,
  table: string,
  where?: readonly RowCondition[],
): StateQuery {
  return where ? { target: `D1:${binding}`, table, where } : { target: `D1:${binding}`, table };
}

/** Every row the query selects satisfies all conditions. */
export function everyRow(
  name: string,
  query: StateQuery,
  holds: readonly RowCondition[],
): EveryRow {
  return { kind: "everyRow", name, query, holds };
}

/** No two rows the query selects share the value at `path` (a column, or a dot path into the row). */
export function unique(name: string, query: StateQuery, path: string): Unique {
  return { kind: "unique", name, query, path };
}

/** Every selected effect has a row whose column equals the effect's key. */
export function implies(
  name: string,
  when: EffectSelector,
  key: string,
  state: StateQuery,
  column: string,
): Implies {
  return { kind: "implies", name, when, key, state, column };
}

/** Selects the acknowledgement that took effect for each message (explicit or implicit; not one ignored after a retry). */
export function queueAck(queueName: string): EffectSelector {
  return {
    target: `Queue:${queueName}`,
    op: "ack",
    kind: "result",
    where: { "result.effective": true },
  };
}

/**
 * Declare an external service: requests to `host` are answered from
 * `responses` (every request gets 200 and an empty body when omitted), and
 * `dedupeBy` names the header whose value makes repeated requests
 * idempotent at that service.
 */
export function external(
  name: string,
  host: string,
  options: { readonly dedupeBy?: string; readonly responses?: readonly ScriptedResponse[] } = {},
): ExternalDecl {
  return {
    name,
    host,
    guarantees: options.dedupeBy ? { dedupeBy: options.dedupeBy } : {},
    ...(options.responses ? { responses: options.responses } : {}),
  };
}

/**
 * Selects the requests to an external that took effect: a request replayed
 * under a dedupe key the external had already seen is not counted.
 */
export function fetchCall(externalName: string, method?: string): EffectSelector {
  return {
    target: `Fetch:${externalName}`,
    ...(method ? { op: method.toUpperCase() } : {}),
    kind: "result",
    where: { "result.effective": true },
  };
}

function validateHttpDrive(drive: HttpDrive): readonly string[] {
  const errors: string[] = [];
  if (drive.requests.length === 0) errors.push("http drive needs at least one request");
  const ids = new Set<string>();
  drive.requests.forEach((r, i) => {
    if (!r.path.startsWith("/")) errors.push(`requests[${i}].path must start with "/"`);
    if (!r.method) errors.push(`requests[${i}].method must not be empty`);
    if (ids.has(r.id)) errors.push(`duplicate request id ${JSON.stringify(r.id)}`);
    ids.add(r.id);
    if ((r.method === "GET" || r.method === "HEAD") && r.body !== undefined)
      errors.push(`requests[${i}] is a ${r.method} and cannot carry a body`);
  });
  errors.push(...validateCaller("http", drive));
  return errors;
}

/** The caller's policy, as both drives a caller resends declare it. */
function validateCaller(
  kind: string,
  drive: {
    readonly retries: number;
    readonly delaysMs?: readonly number[];
    readonly deadlineMs?: number;
  },
): readonly string[] {
  const errors: string[] = [];
  if (!(Number.isInteger(drive.retries) && drive.retries >= 0))
    errors.push(`${kind} drive retries must be a non-negative integer`);
  (drive.delaysMs ?? []).forEach((d, i) => {
    if (!(Number.isInteger(d) && d >= 0))
      errors.push(`${kind} drive delaysMs[${i}] must be a non-negative integer`);
  });
  if (
    drive.deadlineMs !== undefined &&
    !(Number.isInteger(drive.deadlineMs) && drive.deadlineMs > 0)
  )
    errors.push(`${kind} drive deadlineMs must be a positive integer`);
  return errors;
}

function validateCronDrive(drive: CronDrive): readonly string[] {
  const errors: string[] = [];
  try {
    parseCron(drive.cron);
  } catch (err) {
    errors.push(`cron drive: ${(err as Error).message}`);
  }
  if (drive.ticks.length === 0) errors.push("cron drive ticks must be a positive integer");
  const ids = new Set<string>();
  drive.ticks.forEach((t, i) => {
    if (ids.has(t.id)) errors.push(`duplicate tick id ${JSON.stringify(t.id)}`);
    ids.add(t.id);
    const previous = drive.ticks[i - 1];
    if (previous && !(t.at > previous.at))
      errors.push(`ticks[${i}] does not come after ticks[${i - 1}]`);
  });
  if (!(Number.isInteger(drive.retries) && drive.retries >= 0))
    errors.push("cron drive retries must be a non-negative integer");
  return errors;
}

/** A method name the entrypoint can have: an identifier that is not the constructor. */
const methodName = /^[A-Za-z_$][\w$]*$/;

function validateRpcDrive(drive: RpcDrive): readonly string[] {
  const errors: string[] = [];
  if (drive.entrypoint !== undefined && !methodName.test(drive.entrypoint))
    errors.push("rpc drive entrypoint must be an exported class name");
  const ids = new Set<string>();
  drive.calls.forEach((c, i) => {
    if (!methodName.test(c.method) || c.method === "constructor")
      errors.push(`calls[${i}].method must be a method name`);
    if (!Array.isArray(c.args)) errors.push(`calls[${i}].args must be an array`);
    if (ids.has(c.id)) errors.push(`duplicate call id ${JSON.stringify(c.id)}`);
    ids.add(c.id);
  });
  errors.push(...validateCaller("rpc", drive));
  return errors;
}

/** Build and validate a scenario spec; throws with every problem listed. */
export function defineScenario(input: CloudflareScenarioInput): ScenarioSpec {
  // queue() keeps the ids a QueueDrive already has, so it serves both forms.
  const drive: Drive =
    input.drive.kind === "queue" ? queue(input.drive.queue, input.drive.messages) : input.drive;
  const spec: ScenarioSpec = {
    version: 1,
    name: input.name,
    platform: "cloudflare",
    worker: input.worker,
    drive,
    setup: input.setup ?? [],
    externals: input.externals ?? [],
    invariants: input.invariants,
    bounds: { ...defaultBounds, ...input.bounds },
    ...(input.specs ? { specs: input.specs } : {}),
  };
  const errors = [
    ...validateScenario(spec),
    ...(drive.kind === "http" ? validateHttpDrive(drive) : []),
    ...(drive.kind === "rpc" ? validateRpcDrive(drive) : []),
    ...(drive.kind === "cron" ? validateCronDrive(drive) : []),
  ];
  if (errors.length > 0) {
    throw new Error(`invalid scenario ${JSON.stringify(input.name)}:\n- ${errors.join("\n- ")}`);
  }
  return spec;
}
