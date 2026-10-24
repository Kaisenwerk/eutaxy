/** Typed construction of scenario specs for AWS Lambda consumers of SQS with DynamoDB. */

import {
  type AtLeastOnce,
  type Bounds,
  atLeastOncePerMessage as coreAtLeastOncePerMessage,
  defaultBounds,
  type EffectSelector,
  type ExternalDecl,
  type Invariant,
  type JsonValue,
  type PlatformData,
  type RowCondition,
  type ScenarioSpec,
  type StateQuery,
  validateScenario,
  type WorkerRef,
} from "@eutaxy/core";
import type { KeyDef, TableSpec } from "./dynamodb.ts";

export interface SqsMessage {
  readonly id?: string;
  readonly body: JsonValue;
}

/** Drive the Lambda with these SQS messages, one record per invocation. */
export interface SqsDrive extends PlatformData {
  readonly kind: "sqs";
  readonly queue: string;
  readonly messages: readonly { readonly id: string; readonly body: JsonValue }[];
  /** The queue's maxReceiveCount before dead-lettering (AWS has no default; 3 here). */
  readonly maxReceiveCount: number;
}

export function sqs(
  queue: string,
  messages: readonly SqsMessage[],
  options: { readonly maxReceiveCount?: number } = {},
): SqsDrive {
  return {
    kind: "sqs",
    queue,
    messages: messages.map((m, i) => ({ id: m.id ?? `msg-${i + 1}`, body: m.body })),
    maxReceiveCount: options.maxReceiveCount ?? 3,
  };
}

export function dynamoTable(name: string, partitionKey: KeyDef, sortKey?: KeyDef): TableSpec {
  return sortKey
    ? { kind: "dynamodb-table", name, partitionKey, sortKey }
    : { kind: "dynamodb-table", name, partitionKey };
}

/** Selects committed writes to a table: results whose `written` is at least 1. */
export function dynamoWrite(
  table: string,
  op: "PutItem" | "UpdateItem" | "DeleteItem" | "BatchWriteItem" | "TransactWriteItems" = "PutItem",
): EffectSelector {
  return { target: `DynamoDB:${table}`, op, kind: "result", atLeast: { "result.written": 1 } };
}

/** Rows of a table in the end-of-run snapshot. */
export function dynamoRows(table: string, where?: readonly RowCondition[]): StateQuery {
  return where ? { target: "DynamoDB", table, where } : { target: "DynamoDB", table };
}

/** Selects the implicit deletion of each successfully handled message. */
export function sqsDelete(queue: string): EffectSelector {
  return { target: `SQS:${queue}`, op: "delete", kind: "result" };
}

/** Every message's `bodyKey` value must appear at least once as `key` in a selected effect. */
export function atLeastOncePerMessage(
  name: string,
  drive: SqsDrive,
  effect: EffectSelector,
  key: string,
  bodyKey: string,
): AtLeastOnce {
  return coreAtLeastOncePerMessage(name, drive.messages, effect, key, bodyKey);
}

export interface AwsScenarioInput {
  readonly name: string;
  /** The handler module (entry) and, for AWS, a SAM or serverless config path if any (informational). */
  readonly handler: WorkerRef;
  readonly drive: SqsDrive;
  readonly tables?: readonly TableSpec[];
  readonly externals?: readonly ExternalDecl[];
  readonly invariants: readonly Invariant[];
  readonly bounds?: Partial<Bounds>;
}

/** Build and validate a scenario spec for the AWS platform; throws with every problem listed. */
export function defineAwsScenario(input: AwsScenarioInput): ScenarioSpec {
  const spec: ScenarioSpec = {
    version: 1,
    name: input.name,
    platform: "aws",
    worker: input.handler,
    drive: input.drive,
    setup: input.tables ?? [],
    externals: input.externals ?? [],
    invariants: input.invariants,
    bounds: { ...defaultBounds, ...input.bounds },
  };
  const errors = validateScenario(spec);
  if (errors.length > 0)
    throw new Error(`invalid scenario ${JSON.stringify(input.name)}:\n- ${errors.join("\n- ")}`);
  return spec;
}
