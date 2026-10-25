/**
 * The AWS platform: invokes the Lambda handler with one SQS record per
 * event, under the SDK proxy, and applies Lambda's SQS event-source
 * semantics as documented by AWS: a successful return deletes the message
 * (an implicit deletion, which is an effect point), a thrown error or a
 * reported batch item failure leaves it to be redelivered, and after
 * maxReceiveCount deliveries it goes to the dead-letter queue.
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  DeliveryResult,
  EventRef,
  FaultKind,
  JsonValue,
  Platform,
  RunHooks,
  ScenarioSpec,
} from "@eutaxy/core";
import { CrashSignal } from "@eutaxy/engine";
import { resetTables, scenarioTables, snapshotTables } from "./dynamodb.ts";
import {
  batchFailed,
  type LambdaContext,
  type SqsBatchResponse,
  type SqsEvent,
  type SqsHandler,
  type SqsRecord,
  sqsInvocation,
} from "./lambda.ts";
import type { SqsDrive } from "./scenario.ts";
import { installSdkProxy } from "./sdk.ts";

const DELETE: readonly FaultKind[] = ["crash_before", "crash_after"];

export type { LambdaContext, SqsBatchResponse, SqsEvent, SqsHandler, SqsRecord };

export interface AwsPlatformOptions {
  readonly handler: SqsHandler;
  /** Local clients keyed by the class name of the handler's clients, e.g. { DynamoDBClient, DynamoDBDocumentClient }. */
  readonly clients: Readonly<Record<string, object>>;
  readonly functionName?: string;
  readonly region?: string;
}

const assumptions: readonly string[] = [
  "platform model: Lambda with an SQS event source, one record per invocation; a successful return deletes the message, a thrown error or a reported batch item failure leaves it to be redelivered, up to the queue's maxReceiveCount, then it is dead-lettered",
  "every AWS SDK call is one effect, redirected to a local client of the same class; DynamoDB semantics come from the local DynamoDB the platform is given",
  "the handler's clients never reach the network; a client class without a local counterpart makes the run UNSUPPORTED",
  "state invariants read a snapshot of every DynamoDB table named in setup, taken after the last event",
];

export function createAwsPlatform(options: AwsPlatformOptions): Platform {
  const region = options.region ?? "local";
  const functionName = options.functionName ?? "handler";
  const dynamo = options.clients["DynamoDBClient"] as DynamoDBClient | undefined;
  let currentInvocation = "";
  let hooksRef: RunHooks | null = null;
  let restoreProxy: (() => void) | null = null;

  function ensureProxy(hooks: RunHooks): void {
    if (hooksRef === hooks && restoreProxy) return;
    restoreProxy?.();
    hooksRef = hooks;
    restoreProxy = installSdkProxy({
      clients: options.clients,
      hooks,
      invocation: () => currentInvocation,
      unsupported: (r) => hooks.unsupported(r),
    });
  }

  return {
    name: "aws",
    assumptions,

    async reset(spec: ScenarioSpec): Promise<void> {
      const tables = scenarioTables(spec);
      if (tables.length === 0) return;
      if (!dynamo)
        throw new Error(
          "the scenario sets up DynamoDB tables but no DynamoDBClient was given in clients",
        );
      await resetTables(dynamo, tables);
    },

    async finish(spec: ScenarioSpec, hooks: RunHooks): Promise<void> {
      const tables = scenarioTables(spec);
      if (tables.length === 0 || !dynamo) return;
      const snapshot = await snapshotTables(dynamo, tables);
      hooks.snapshot(hooks.bookkeeping(), "DynamoDB", { tables: snapshot });
    },

    async cleanup(): Promise<void> {
      restoreProxy?.();
      restoreProxy = null;
      hooksRef = null;
    },

    restrictEvents(spec: ScenarioSpec, keepIds: readonly string[]): ScenarioSpec {
      const drive = spec.drive as SqsDrive;
      return {
        ...spec,
        drive: { ...drive, messages: drive.messages.filter((m) => keepIds.includes(m.id)) },
      };
    },

    initialEvents(spec: ScenarioSpec): readonly EventRef[] {
      const drive = spec.drive as SqsDrive;
      if (drive.kind !== "sqs")
        throw new Error(`drive ${drive.kind} is not supported by the AWS platform`);
      return drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    },

    async deliver(event: EventRef, hooks: RunHooks, spec: ScenarioSpec): Promise<DeliveryResult> {
      ensureProxy(hooks);
      const drive = spec.drive as SqsDrive;
      const queueTarget = `SQS:${drive.queue}`;
      const invocation = `${event.id}#${event.attempt}`;
      currentInvocation = invocation;
      const inv = hooks.startInvocation(invocation);
      const now = Date.now();
      const { record, context } = sqsInvocation(
        event,
        { queue: drive.queue, region, functionName },
        now,
      );

      const outcome = Promise.resolve()
        .then(() => options.handler({ Records: [record] }, context))
        .then(
          (response) => ({
            status: "completed" as const,
            response: (response ?? undefined) as SqsBatchResponse | undefined,
          }),
          (err: unknown) => ({
            status: err instanceof CrashSignal ? ("crashed" as const) : ("errored" as const),
            response: undefined,
          }),
        );
      let { status, response } = await Promise.race([
        hooks.settle(outcome, invocation),
        inv.crashed.then(() => ({ status: "crashed" as const, response: undefined })),
      ]);

      let deleted = false;
      const failed = batchFailed(response, event.id, [event.id]);
      if (status === "completed" && !failed) {
        try {
          hooks.effectSync(
            {
              invocation,
              target: queueTarget,
              op: "delete",
              args: { messageId: event.id, implicit: true } as JsonValue,
              allowed: DELETE,
            },
            () => {
              deleted = true;
            },
            () => null,
          );
        } catch (err) {
          if (!(err instanceof CrashSignal)) throw err;
          status = "crashed";
        }
      }

      const followUps: EventRef[] = [];
      if (!deleted) {
        if (
          event.attempt < drive.maxReceiveCount &&
          event.attempt - 1 < spec.bounds.maxRedeliveries
        ) {
          followUps.push({ ...event, attempt: event.attempt + 1 });
        } else {
          hooks.effectSync(
            {
              invocation: hooks.bookkeeping(),
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
      currentInvocation = "";
      return { status, followUps };
    },
  };
}
