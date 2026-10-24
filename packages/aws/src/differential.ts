/**
 * Differential check for the AWS platform: the proxied run against a raw run
 * in which the handler is called directly, with SDK calls only redirected to
 * the local clients (no recording, no faults) and the queue model applied by
 * hand. Per-attempt outcomes and the final tables must agree.
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { EventRef, JsonValue, ScenarioSpec } from "@eutaxy/core";
import {
  compareSides,
  DifferentialStuck,
  effectLatencyMs,
  installScriptedFetch,
  patchGlobals,
  proxiedSide,
  settleOn,
} from "@eutaxy/engine";
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
  const patched = patchGlobals(0);
  const reasons: string[] = [];
  const restoreFetch = installScriptedFetch(
    spec.externals,
    null,
    (r) => reasons.push(r),
    () => patched.clock.advance(effectLatencyMs),
  );
  const io = { n: 0 };
  const restoreSdk = installSdkProxy({
    clients: options.clients,
    hooks: null,
    invocation: () => "",
    unsupported: (r) => reasons.push(r),
    afterCall: () => patched.clock.advance(effectLatencyMs),
    // Real SDK I/O: count it as in flight and give the SDK real timers, as the proxied side does.
    wrapCall: async (perform) => {
      io.n++;
      try {
        return await patched.libraryIo(perform);
      } finally {
        io.n--;
      }
    },
  });
  const attempts: AttemptRecord[] = [];
  try {
    const pending: EventRef[] = drive.messages.map((m) => ({ id: m.id, attempt: 1, data: m.body }));
    while (pending.length > 0) {
      const event = pending.shift() as EventRef;
      const now = Date.now();
      const { record, context } = sqsInvocation(
        event,
        {
          queue: drive.queue,
          region: options.region ?? "local",
          functionName: options.functionName ?? "handler",
        },
        now,
      );
      let status: "completed" | "errored";
      let response: SqsBatchResponse | undefined;
      try {
        response = (await settleOn(
          Promise.resolve().then(() => options.handler({ Records: [record] }, context)),
          {
            clock: patched.clock,
            inFlight: () => io.n,
            crashed: () => false,
            stuck: () => {
              throw new DifferentialStuck();
            },
          },
        )) as SqsBatchResponse | undefined;
        status = "completed";
      } catch (err) {
        if (err instanceof DifferentialStuck) throw err;
        status = "errored";
      }
      const failed = batchFailed(response, event.id, [event.id]);
      const deleted = status === "completed" && !failed;
      attempts.push({ event: event.id, attempt: event.attempt, status, deleted });
      if (
        !deleted &&
        event.attempt < drive.maxReceiveCount &&
        event.attempt - 1 < spec.bounds.maxRedeliveries
      ) {
        pending.push({ ...event, attempt: event.attempt + 1 });
      }
    }
  } finally {
    restoreSdk();
    restoreFetch();
    patched.restore();
  }
  if (reasons.length > 0) throw new Error(`raw side: ${reasons.join("; ")}`);
  const tables = dynamo ? await snapshotTables(dynamo, scenarioTables(spec)) : {};
  return { attempts, tables };
}

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
