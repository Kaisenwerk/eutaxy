/**
 * Typed construction of scenario specs for Cloudflare Workers. Everything here
 * produces the plain-data `ScenarioSpec` from core; this module only knows the
 * Cloudflare shapes (queues, D1 bindings) and the effect conventions the
 * proxies follow.
 */

import {
  type AtLeastOnce,
  type AtMostOncePerKey,
  type Bounds,
  defaultBounds,
  type EffectSelector,
  type EveryRow,
  type ExternalDecl,
  getPath,
  type Implies,
  type Invariant,
  type JsonValue,
  type PlatformData,
  type RowCondition,
  type ScenarioSpec,
  type ScriptedResponse,
  type StateQuery,
  type Unique,
  validateScenario,
  type WorkerRef,
} from "@eutaxy/core";

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

/** The virtual delay before resend number `resend` (1 for the first), per the drive's caller. */
export function retryDelayMs(drive: HttpDrive, resend: number): number {
  const delays = drive.delaysMs ?? [];
  return delays[Math.min(resend, delays.length) - 1] ?? 0;
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
    | {
        readonly kind: "queue";
        readonly queue: string;
        readonly messages: readonly QueueMessage[];
      };
  readonly setup?: readonly (D1Setup | DurableObjectSetup)[];
  readonly externals?: readonly ExternalDecl[];
  readonly invariants: readonly Invariant[];
  readonly bounds?: Partial<Bounds>;
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

/** Dot path to the Nth bound parameter of a D1 statement, in an effect payload. */
export function d1Param(index: number): string {
  return `args.params.${index}`;
}

export function atMostOncePerKey(
  name: string,
  effect: EffectSelector,
  key: string,
): AtMostOncePerKey {
  return { kind: "atMostOncePerKey", name, effect, key };
}

export function atLeastOnce(
  name: string,
  effect: EffectSelector,
  key: string,
  expected: readonly JsonValue[],
): AtLeastOnce {
  return { kind: "atLeastOnce", name, effect, key, expected };
}

/**
 * Every message's (or request's) `bodyKey` value must appear at least once
 * as `key` in a selected effect: nothing the drive delivered may be lost.
 */
export function atLeastOncePerMessage(
  name: string,
  drive: QueueDrive | HttpDrive,
  effect: EffectSelector,
  key: string,
  bodyKey: string,
): AtLeastOnce {
  const expected: JsonValue[] = [];
  const items =
    drive.kind === "queue"
      ? drive.messages.map((m) => ({ id: m.id, body: m.body }))
      : drive.requests.map((r) => ({ id: r.id, body: r.body ?? null }));
  for (const m of items) {
    const v = getPath(m.body, bodyKey);
    if (v === undefined) {
      throw new Error(`${drive.kind} event ${m.id} has no ${JSON.stringify(bodyKey)} in its body`);
    }
    expected.push(v);
  }
  // An HTTP event's data is the whole request, so the path to re-derive from starts at its body.
  const perMessage = {
    bodyKey: drive.kind === "queue" ? bodyKey : bodyKey === "" ? "body" : `body.${bodyKey}`,
  };
  return { ...atLeastOnce(name, effect, key, expected), perMessage };
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
  if (!(Number.isInteger(drive.retries) && drive.retries >= 0))
    errors.push("http drive retries must be a non-negative integer");
  (drive.delaysMs ?? []).forEach((d, i) => {
    if (!(Number.isInteger(d) && d >= 0))
      errors.push(`http drive delaysMs[${i}] must be a non-negative integer`);
  });
  if (
    drive.deadlineMs !== undefined &&
    !(Number.isInteger(drive.deadlineMs) && drive.deadlineMs > 0)
  )
    errors.push("http drive deadlineMs must be a positive integer");
  return errors;
}

/** Build and validate a scenario spec; throws with every problem listed. */
export function defineScenario(input: CloudflareScenarioInput): ScenarioSpec {
  const drive: QueueDrive | HttpDrive =
    input.drive.kind === "http"
      ? input.drive
      : "messages" in input.drive &&
          input.drive.messages.every((m) => "id" in m && typeof m.id === "string")
        ? (input.drive as QueueDrive)
        : queue(input.drive.queue, input.drive.messages);
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
  };
  const errors = [
    ...validateScenario(spec),
    ...(drive.kind === "http" ? validateHttpDrive(drive) : []),
  ];
  if (errors.length > 0) {
    throw new Error(`invalid scenario ${JSON.stringify(input.name)}:\n- ${errors.join("\n- ")}`);
  }
  return spec;
}
