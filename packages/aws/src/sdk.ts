/**
 * The AWS SDK proxy. Every v3 client extends the Smithy `Client`, whose
 * `send` is the single point every call passes through. For the duration of
 * a run it is replaced: the call becomes an effect point (when run hooks are
 * given) and the real work is sent through a local client the platform was
 * given, matched by the calling client's class name, so the handler's own
 * clients never reach the network.
 */

import type { EffectPoint, FaultKind, JsonValue, RunHooks } from "@eutaxy/core";
import { Client } from "@smithy/smithy-client";
import { toJson } from "./json.ts";

const WRITE: readonly FaultKind[] = ["crash_before", "crash_after", "ambiguous", "error"];
const READ: readonly FaultKind[] = ["crash_before", "crash_after", "error"];
const READS = new Set([
  "GetItem",
  "BatchGetItem",
  "Query",
  "Scan",
  "TransactGetItems",
  "DescribeTable",
  "ListTables",
]);

/** DocumentClient commands map onto the low-level ones; one name per operation in the log. */
const DOCUMENT_ALIASES: Readonly<Record<string, string>> = {
  Put: "PutItem",
  Get: "GetItem",
  Update: "UpdateItem",
  Delete: "DeleteItem",
  BatchWrite: "BatchWriteItem",
  BatchGet: "BatchGetItem",
  TransactWrite: "TransactWriteItems",
  TransactGet: "TransactGetItems",
};

export function normalizeOp(commandName: string): string {
  const op = commandName.replace(/Command$/, "");
  return DOCUMENT_ALIASES[op] ?? op;
}

/** The tables a DynamoDB command touches, including batch and transactional ones. */
export function tablesOf(
  op: string,
  input: Record<string, unknown> | undefined,
): readonly string[] {
  if (!input) return [];
  const names = new Set<string>();
  if (typeof input["TableName"] === "string") names.add(input["TableName"]);
  if (op === "BatchWriteItem" || op === "BatchGetItem") {
    for (const t of Object.keys((input["RequestItems"] as object | undefined) ?? {})) names.add(t);
  }
  if (op === "TransactWriteItems" || op === "TransactGetItems") {
    const items =
      (input["TransactItems"] as Record<string, { TableName?: string }>[] | undefined) ?? [];
    for (const item of items) {
      for (const action of Object.values(item)) {
        if (action && typeof action.TableName === "string") names.add(action.TableName);
      }
    }
  }
  return [...names].sort();
}

type AnyClient = { readonly config?: { serviceId?: string }; constructor: { name: string } };
type AnyCommand = { readonly input?: unknown; constructor: { name: string } };
type Send = (this: AnyClient, command: AnyCommand, ...rest: unknown[]) => Promise<unknown>;

/** The unpatched `send`, captured at module load; the platform uses it for its own local calls. */
export const originalSend: Send = Client.prototype.send as unknown as Send;

/** Send a command through a client without the proxy (for reset and snapshots). */
export function rawSend<T>(client: object, command: object): Promise<T> {
  return originalSend.call(client as AnyClient, command as AnyCommand) as Promise<T>;
}

export interface SdkProxyOptions {
  /** Local clients keyed by the class name of the client that made the call. */
  readonly clients: Readonly<Record<string, object>>;
  /** With hooks, calls are effect points; without, they are only redirected (the differential's raw side). */
  readonly hooks: RunHooks | null;
  readonly invocation: () => string;
  readonly unsupported: (reason: string) => void;
  /** Called after each redirected call without hooks, e.g. to advance a clock as an effect would. */
  readonly afterCall?: () => void;
  /** Without hooks: wraps each redirected call (in-flight tracking, real timers for the SDK). */
  readonly wrapCall?: <T>(perform: () => Promise<T>) => Promise<T>;
}

/** `DynamoDB:<table>`, or `DynamoDB:<a>+<b>` for a batch or transaction spanning several tables. */
export function targetOf(
  serviceId: string,
  op: string,
  input: Record<string, unknown> | undefined,
): string {
  if (serviceId === "DynamoDB") {
    const tables = tablesOf(op, input);
    return tables.length > 0 ? `DynamoDB:${tables.join("+")}` : "DynamoDB";
  }
  const name = input?.["QueueUrl"] ?? input?.["Bucket"] ?? input?.["TopicArn"];
  return typeof name === "string" ? `${serviceId}:${name.split("/").pop() ?? name}` : serviceId;
}

/** A compact, JSON summary of a command's result for the effect log. */
export function summarize(
  op: string,
  result: unknown,
  input?: Record<string, unknown> | undefined,
): JsonValue {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (op) {
    case "PutItem":
    case "UpdateItem":
    case "DeleteItem":
      return { written: 1 };
    case "BatchWriteItem": {
      // Partial success is normal: the committed count is what was requested minus what came back.
      const count = (items: unknown) =>
        Object.values((items as Record<string, unknown[]> | undefined) ?? {}).flat().length;
      const requested = count(input?.["RequestItems"]);
      const unprocessed = count(r["UnprocessedItems"]);
      return { written: Math.max(0, requested - unprocessed), unprocessed };
    }
    case "TransactWriteItems":
      return { written: 1 };
    case "GetItem":
      return { found: r["Item"] !== undefined };
    case "Query":
    case "Scan":
      return {
        count:
          typeof r["Count"] === "number"
            ? r["Count"]
            : ((r["Items"] as unknown[] | undefined)?.length ?? 0),
      };
    default:
      return { ok: true };
  }
}

/** Replace `Client.prototype.send` for a run; returns the function that restores it. Safe to call twice. */
export function installSdkProxy(options: SdkProxyOptions): () => void {
  const proto = Client.prototype as unknown as { send: Send };
  const saved = proto.send;
  const patched: Send = async function (this: AnyClient, command: AnyCommand, ...rest: unknown[]) {
    const className = this.constructor.name;
    const local = options.clients[className];
    if (!local) {
      options.unsupported(
        `no local client configured for ${className}; pass one in createAwsPlatform({ clients })`,
      );
      throw new Error(`eutaxy: no local client for ${className}`);
    }
    const callback = rest.find((a): a is (err: unknown) => void => typeof a === "function");
    if (callback) {
      // The callback form returns nothing to await, so its outcome cannot be an effect point.
      // The handler sees the error through its callback, as the SDK would deliver one.
      const reason = `callback-style send(${command.constructor.name}, cb) is not modelled; await the promise form`;
      options.unsupported(reason);
      queueMicrotask(() => callback(new Error(`eutaxy: ${reason}`)));
      return undefined;
    }
    const serviceId = this.config?.serviceId ?? className.replace(/(Document)?Client$/, "");
    const op = normalizeOp(command.constructor.name);
    const input = command.input as Record<string, unknown> | undefined;
    const perform = () => originalSend.call(local as AnyClient, command, ...rest);
    if (!options.hooks) {
      try {
        return await (options.wrapCall ? options.wrapCall(perform) : perform());
      } finally {
        options.afterCall?.();
      }
    }
    const point: EffectPoint = {
      invocation: options.invocation(),
      target: targetOf(serviceId, op, input),
      op,
      args: toJson(input),
      allowed: READS.has(op) ? READ : WRITE,
    };
    return options.hooks.effect(point, perform, (r) => summarize(op, r, input));
  };
  proto.send = patched;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    proto.send = saved;
  };
}
