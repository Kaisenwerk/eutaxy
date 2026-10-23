/**
 * Differential check for the AWS platform: the proxied run against a raw run
 * in which the handler is called directly, with SDK calls only redirected to
 * the local clients (no recording, no faults) and the queue model applied by
 * hand. Per-attempt outcomes and the final tables must agree.
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { canonicalJson, type EventRef, type JsonValue, type ScenarioSpec } from "@eutaxy/core";
import { effectLatencyMs, installScriptedFetch, patchGlobals, Run, settleOn } from "@eutaxy/engine";
import { resetTables, snapshotTables, type TableSpec } from "./dynamodb.ts";
import { batchFailed, type SqsBatchResponse, sqsInvocation } from "./lambda.ts";
import { type AwsPlatformOptions, createAwsPlatform } from "./platform.ts";
import type { SqsDrive } from "./scenario.ts";
import { installSdkProxy } from "./sdk.ts";

export interface AttemptRecord {
  readonly event: string;
  readonly attempt: number;
  readonly status: "completed" | "errored";
  readonly deleted: boolean;
}

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

/** The raw side cannot abandon an invocation the way the engine does; a stuck handler ends the comparison. */
class StuckError extends Error {
  override readonly name = "StuckError";
  constructor() {
    super(
      "raw side: the handler is waiting on something outside the run (no SDK call in flight, no timer due)",
    );
  }
}

function tablesOf(spec: ScenarioSpec): readonly TableSpec[] {
  return spec.setup.filter((s): s is TableSpec => s.kind === "dynamodb-table");
}

async function eutaxySide(
  spec: ScenarioSpec,
  options: AwsPlatformOptions,
): Promise<Side & { unsupported: readonly string[] }> {
  const platform = createAwsPlatform(options);
  const run = new Run({
    mode: "replay",
    schedule: { seed: 0, faults: [] },
    bounds: spec.bounds,
    faultProbability: 0,
  });
  const attempts: AttemptRecord[] = [];
  await platform.reset(spec);
  run.install(spec.externals);
  try {
    try {
      const pending: EventRef[] = [...platform.initialEvents(spec)];
      while (pending.length > 0) {
        const event = pending.shift() as EventRef;
        const before = run.log.entries.length;
        const result = await platform.deliver(event, run, spec);
        const deleted = run.log.entries
          .slice(before)
          .some((e) => e.kind === "result" && e.op === "delete");
        attempts.push({
          event: event.id,
          attempt: event.attempt,
          status: result.status === "completed" ? "completed" : "errored",
          deleted,
        });
        pending.push(...result.followUps);
      }
    } finally {
      run.uninstall();
    }
    await platform.finish?.(spec, run);
  } finally {
    await platform.cleanup?.(spec);
  }
  const dynamo = options.clients["DynamoDBClient"] as DynamoDBClient | undefined;
  const tables = dynamo ? await snapshotTables(dynamo, tablesOf(spec)) : {};
  return { attempts, tables, unsupported: run.unsupportedReasons };
}

async function rawSide(spec: ScenarioSpec, options: AwsPlatformOptions): Promise<Side> {
  const drive = spec.drive as SqsDrive;
  const dynamo = options.clients["DynamoDBClient"] as DynamoDBClient | undefined;
  if (dynamo) await resetTables(dynamo, tablesOf(spec));
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
              throw new StuckError();
            },
          },
        )) as SqsBatchResponse | undefined;
        status = "completed";
      } catch (err) {
        if (err instanceof StuckError) throw err;
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
  const tables = dynamo ? await snapshotTables(dynamo, tablesOf(spec)) : {};
  return { attempts, tables };
}

export async function runAwsDifferential(
  spec: ScenarioSpec,
  options: AwsPlatformOptions,
): Promise<DifferentialResult> {
  const { unsupported, ...eutaxy } = await eutaxySide(spec, options);
  const raw = await rawSide(spec, options);
  const differences: string[] = [];
  if (unsupported.length > 0)
    differences.push(`the proxied run touched unsupported APIs: ${unsupported.join("; ")}`);
  const a = canonicalJson(eutaxy.attempts as unknown as JsonValue);
  const b = canonicalJson(raw.attempts as unknown as JsonValue);
  if (a !== b) differences.push(`attempts differ:\n  eutaxy ${a}\n  raw    ${b}`);
  const names = new Set([...Object.keys(eutaxy.tables), ...Object.keys(raw.tables)]);
  for (const t of [...names].sort()) {
    const x = canonicalJson((eutaxy.tables[t] ?? []) as unknown as JsonValue);
    const y = canonicalJson((raw.tables[t] ?? []) as unknown as JsonValue);
    if (x !== y) differences.push(`${t} differs:\n  eutaxy ${x}\n  raw    ${y}`);
  }
  return { equal: differences.length === 0, eutaxy, raw, differences, unsupported };
}
