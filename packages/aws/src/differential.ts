/**
 * Differential check for the AWS platform: the proxied run against a raw run
 * in which the handler is called directly, with SDK calls only redirected to
 * the local clients (no recording, no faults) and the queue model applied by
 * the engine's raw loop. Per-attempt outcomes and the final tables must agree.
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { JsonValue, ScenarioSpec } from "@eutaxy/core";
import { compareSides, effectLatencyMs, proxiedSide, rawRun } from "@eutaxy/engine";
import { resetTables, scenarioTables, snapshotTables } from "./dynamodb.ts";
import { batchFailed, type SqsBatchResponse, sqsInvocation } from "./lambda.ts";
import { type AwsPlatformOptions, createAwsPlatform } from "./platform.ts";
import type { SqsDrive } from "./scenario.ts";
import { installSdkProxy } from "./sdk.ts";

/** A type, not an interface, so it is JSON data the comparison takes as it is. */
export type AttemptRecord = {
  readonly event: string;
  readonly attempt: number;
  readonly status: "completed" | "errored";
  readonly deleted: boolean;
};

export interface Side {
  readonly attempts: readonly AttemptRecord[];
  readonly tables: { readonly [table: string]: readonly JsonValue[] };
}

/**
 * What `runAwsDifferential` found: whether the proxied run and the raw run agree, each side's attempts and
 * tables, the differences when they do not, and any reason the proxied side was UNSUPPORTED.
 */
export interface DifferentialResult {
  readonly equal: boolean;
  readonly eutaxy: Side;
  readonly raw: Side;
  readonly differences: readonly string[];
  readonly unsupported: readonly string[];
}

async function eutaxySide(
  spec: ScenarioSpec,
  options: AwsPlatformOptions,
): Promise<Side & { unsupported: readonly string[] }> {
  const { attempts, unsupported } = await proxiedSide(
    spec,
    createAwsPlatform(options),
    (event, result, entries): AttemptRecord => ({
      event: event.id,
      attempt: event.attempt,
      status: result.status === "completed" ? "completed" : "errored",
      deleted: entries.some((e) => e.kind === "result" && e.op === "delete"),
    }),
  );
  const dynamo = options.clients["DynamoDBClient"] as DynamoDBClient | undefined;
  const tables = dynamo ? await snapshotTables(dynamo, scenarioTables(spec)) : {};
  return { attempts, tables, unsupported };
}

async function rawSide(spec: ScenarioSpec, options: AwsPlatformOptions): Promise<Side> {
  const drive = spec.drive as SqsDrive;
  const dynamo = options.clients["DynamoDBClient"] as DynamoDBClient | undefined;
  if (dynamo) await resetTables(dynamo, scenarioTables(spec));
  const attempts = await rawRun<AttemptRecord>(spec, {
    events: drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body })),
    limit: drive.maxReceiveCount - 1,
    install: (ctx) => ({
      restore: installSdkProxy({
        clients: options.clients,
        hooks: null,
        invocation: () => "",
        unsupported: ctx.unsupported,
        afterCall: () => ctx.clock.advance(effectLatencyMs),
        // Real SDK I/O: count it as in flight and give the SDK real timers, as the proxied side does.
        wrapCall: async (perform) => {
          ctx.io.n++;
          try {
            return await ctx.libraryIo(perform);
          } finally {
            ctx.io.n--;
          }
        },
      }),
      attempt: async (event) => {
        const { record, context } = sqsInvocation(
          event,
          {
            queue: drive.queue,
            region: options.region ?? "local",
            functionName: options.functionName ?? "handler",
          },
          Date.now(),
        );
        const ran = await ctx.call(() => options.handler({ Records: [record] }, context));
        const response =
          ran.status === "completed" ? (ran.value as SqsBatchResponse | undefined) : undefined;
        const failed = batchFailed(response, event.id, [event.id]);
        const deleted = ran.status === "completed" && !failed;
        return {
          record: { event: event.id, attempt: event.attempt, status: ran.status, deleted },
          handled: deleted,
        };
      },
    }),
  });
  const tables = dynamo ? await snapshotTables(dynamo, scenarioTables(spec)) : {};
  return { attempts, tables };
}

/**
 * Run a scenario through Eutaxy's proxies and again with the handler calling the raw local clients, and
 * compare the attempts and the final tables: the check that the proxies change nothing the handler sees.
 */
export async function runAwsDifferential(
  spec: ScenarioSpec,
  options: AwsPlatformOptions,
): Promise<DifferentialResult> {
  const { unsupported, ...eutaxy } = await eutaxySide(spec, options);
  const raw = await rawSide(spec, options);
  const differences = compareSides(
    { attempts: eutaxy.attempts, state: eutaxy.tables },
    { attempts: raw.attempts, state: raw.tables },
    unsupported,
  );
  return { equal: differences.length === 0, eutaxy, raw, differences, unsupported };
}
