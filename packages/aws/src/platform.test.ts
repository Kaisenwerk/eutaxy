/** The AWS platform against an in-process DynamoDB (dynalite): the queue model, the SDK proxy, snapshots. */
import type { Server } from "node:http";
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { atMostOncePerKey, digestLog, type ScenarioSpec, selectEffects } from "@eutaxy/core";
import { explore, replay } from "@eutaxy/engine";
import { Client } from "@smithy/smithy-client";
import dynalite from "dynalite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runAwsDifferential } from "./differential.ts";
import { listAllTables, resetTables } from "./dynamodb.ts";
import { createAwsPlatform, type SqsHandler } from "./platform.ts";
import {
  atLeastOncePerMessage,
  defineAwsScenario,
  dynamoRows,
  dynamoTable,
  dynamoWrite,
  sqs,
  sqsDelete,
} from "./scenario.ts";
import { originalSend, rawSend } from "./sdk.ts";

let server: Server;
let local: DynamoDBClient;
let localDoc: DynamoDBDocumentClient;

beforeAll(async () => {
  server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  local = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  localDoc = DynamoDBDocumentClient.from(local);
});

afterAll(async () => {
  local.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A handler written the way Lambda code is: clients at module scope, pointed at the real region. */
const remote = new DynamoDBClient({
  region: "us-east-1",
  credentials: { accessKeyId: "x", secretAccessKey: "x" },
});
const remoteDoc = DynamoDBDocumentClient.from(remote);

const payments = sqs("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

function scenario(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  return {
    ...defineAwsScenario({
      name: "sqs-payments",
      handler: { entry: "./handler.ts", config: "template.yaml" },
      drive: payments,
      tables: [dynamoTable("payments", { name: "pk", type: "S" }, { name: "sk", type: "S" })],
      invariants: [
        atMostOncePerKey("payment-recorded-once", dynamoWrite("payments"), "args.Item.order_id.S"),
        atLeastOncePerMessage(
          "every-payment-recorded",
          payments,
          dynamoWrite("payments"),
          "args.Item.order_id.S",
          "orderId",
        ),
      ],
      bounds: {
        maxFaultsPerRun: 1,
        maxRedeliveries: 2,
        maxConcurrentInvocations: 1,
        budgetMs: 10_000,
      },
    }),
    ...overrides,
  };
}

/** The planted bug: PutItem under a fresh sort key, so a redelivery writes a second item for the order. */
const buggy: SqsHandler = async (event) => {
  for (const record of event.Records) {
    const { orderId, amountCents } = JSON.parse(record.body) as {
      orderId: string;
      amountCents: number;
    };
    await remote.send(
      new PutItemCommand({
        TableName: "payments",
        Item: {
          pk: { S: "payment" },
          sk: { S: crypto.randomUUID() },
          order_id: { S: orderId },
          amount_cents: { N: String(amountCents) },
        },
      }),
    );
  }
};

/** The fix: the order id is the key and the put is conditional, so a retry changes nothing. */
const fixed: SqsHandler = async (event) => {
  for (const record of event.Records) {
    const { orderId, amountCents } = JSON.parse(record.body) as {
      orderId: string;
      amountCents: number;
    };
    try {
      await remote.send(
        new PutItemCommand({
          TableName: "payments",
          Item: {
            pk: { S: "payment" },
            sk: { S: orderId },
            order_id: { S: orderId },
            amount_cents: { N: String(amountCents) },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    }
  }
};

const clients = () => ({ DynamoDBClient: local, DynamoDBDocumentClient: localDoc });

describe("SQS delivery and DynamoDB effects", () => {
  test("a fault-free run records the put, the implicit delete, and a snapshot", async () => {
    const log = await replay(
      scenario(),
      createAwsPlatform({ handler: buggy, clients: clients() }),
      { seed: 1, faults: [] },
    );
    const ops = log.entries.map((e) => `${e.invocation} ${e.kind} ${e.target} ${e.op}`);
    expect(ops).toEqual([
      "msg-1#1 call DynamoDB:payments PutItem",
      "msg-1#1 result DynamoDB:payments PutItem",
      "msg-1#1 call SQS:payments delete",
      "msg-1#1 result SQS:payments delete",
      "msg-2#1 call DynamoDB:payments PutItem",
      "msg-2#1 result DynamoDB:payments PutItem",
      "msg-2#1 call SQS:payments delete",
      "msg-2#1 result SQS:payments delete",
      "platform snapshot DynamoDB snapshot",
    ]);
    expect(log.entries[1]?.payload).toMatchObject({ result: { written: 1 } });
    const snapshot = log.entries.at(-1)?.payload as { tables: { payments: unknown[] } };
    expect(snapshot.tables.payments).toHaveLength(2);
    expect(snapshot.tables.payments[0]).toMatchObject({
      pk: "payment",
      order_id: "o-1",
      amount_cents: 1200,
    });
  });

  test("the buggy handler duplicates a payment under redelivery; the fixed one is BOUNDED", async () => {
    const bad = await explore(
      scenario(),
      createAwsPlatform({ handler: buggy, clients: clients() }),
      { seed: "sqs", now: () => 0 },
    );
    expect(bad.kind).toBe("VIOLATED");
    if (bad.kind === "VIOLATED") {
      expect(bad.violation.invariant).toBe("payment-recorded-once");
      expect(bad.keptEvents).toHaveLength(1);
    }
    const good = await explore(
      scenario(),
      createAwsPlatform({ handler: fixed, clients: clients() }),
      { seed: "sqs", maxRuns: 30, now: () => 0 },
    );
    expect(good.kind, JSON.stringify(good)).toBe("BOUNDED");
  });

  test("a conditional put that fails is recorded as a result with the error, not a write", async () => {
    const log = await replay(
      scenario({
        drive: sqs("payments", [
          { body: { orderId: "o-1", amountCents: 1 } },
          { body: { orderId: "o-1", amountCents: 1 } },
        ]),
      }),
      createAwsPlatform({ handler: fixed, clients: clients() }),
      { seed: 1, faults: [] },
    );
    const puts = log.entries.filter((e) => e.kind === "result" && e.op === "PutItem");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.payload).toMatchObject({ result: { written: 1 } });
    expect(puts[1]?.payload).toMatchObject({
      result: null,
      error: expect.stringContaining("ConditionalCheckFailedException"),
    });
  });

  test("a thrown error redelivers; a reported batch item failure redelivers; a return deletes", async () => {
    let calls = 0;
    const flaky: SqsHandler = async (event) => {
      calls++;
      if (calls === 1) throw new Error("transient");
      if (calls === 2)
        return { batchItemFailures: [{ itemIdentifier: event.Records[0]?.messageId ?? "" }] };
      return undefined;
    };
    const log = await replay(
      scenario({
        drive: sqs("payments", [{ body: { orderId: "o-1", amountCents: 1 } }]),
        invariants: [atMostOncePerKey("x", dynamoWrite("payments"), "args.Item.order_id.S")],
      }),
      createAwsPlatform({ handler: flaky, clients: clients() }),
      { seed: 1, faults: [] },
    );
    const attempts = [
      ...new Set(log.entries.filter((e) => e.kind !== "snapshot").map((e) => e.invocation)),
    ];
    expect(attempts).toEqual(["msg-1#3"]);
    expect(calls).toBe(3);
  });

  test("DocumentClient calls are redirected too and recorded with plain values", async () => {
    const doc: SqsHandler = async (event) => {
      for (const record of event.Records) {
        const { orderId } = JSON.parse(record.body) as { orderId: string };
        await remoteDoc.send(
          new PutCommand({
            TableName: "payments",
            Item: { pk: "payment", sk: orderId, order_id: orderId },
          }),
        );
      }
    };
    const log = await replay(scenario(), createAwsPlatform({ handler: doc, clients: clients() }), {
      seed: 1,
      faults: [],
    });
    const put = log.entries.find(
      (e) => e.kind === "call" && e.op === "PutItem" && e.invocation === "msg-1#1",
    );
    expect(put?.payload).toEqual({
      args: { Item: { order_id: "o-1", pk: "payment", sk: "o-1" }, TableName: "payments" },
    });
  });

  test("a single-table BatchWriteItem is attributed to its table and matched by dynamoWrite", async () => {
    const batch: SqsHandler = async (event) => {
      for (const record of event.Records) {
        const { orderId } = JSON.parse(record.body) as { orderId: string };
        await remote.send(
          new BatchWriteItemCommand({
            RequestItems: {
              payments: [
                {
                  PutRequest: { Item: marshall({ pk: "payment", sk: orderId, order_id: orderId }) },
                },
              ],
            },
          }),
        );
      }
    };
    const log = await replay(
      scenario(),
      createAwsPlatform({ handler: batch, clients: clients() }),
      {
        seed: 1,
        faults: [],
      },
    );
    const write = log.entries.find((e) => e.kind === "result" && e.op === "BatchWriteItem");
    expect(write?.target).toBe("DynamoDB:payments");
    expect(write?.payload).toMatchObject({ result: { written: 1, unprocessed: 0 } });
    const selected = selectEffects(log, dynamoWrite("payments", "BatchWriteItem"));
    expect(selected).toHaveLength(payments.messages.length);
  });

  test("callback-style send is UNSUPPORTED rather than recorded as an instant success", async () => {
    const viaCallback: SqsHandler = async () =>
      new Promise<void>((resolve, reject) => {
        (remote.send as unknown as (c: unknown, cb: (err: unknown) => void) => void)(
          new PutItemCommand({
            TableName: "payments",
            Item: marshall({ pk: "payment", sk: "cb", order_id: "cb" }),
          }),
          (err) => (err ? reject(err) : resolve()),
        );
      });
    const verdict = await explore(
      scenario(),
      createAwsPlatform({ handler: viaCallback, clients: clients() }),
      { seed: 1, maxRuns: 2 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("callback-style");
  });

  test("the raw differential side sees the same function name and ARN as the proxied side", async () => {
    const branching: SqsHandler = async (event, context) => {
      if (!context.invokedFunctionArn.endsWith(":function:custom")) throw new Error("wrong ARN");
      for (const record of event.Records) {
        const { orderId } = JSON.parse(record.body) as { orderId: string };
        await remote.send(
          new PutItemCommand({
            TableName: "payments",
            Item: marshall({ pk: "payment", sk: orderId, order_id: orderId }),
          }),
        );
      }
    };
    const result = await runAwsDifferential(scenario(), {
      handler: branching,
      clients: clients(),
      functionName: "custom",
      region: "eu-west-1",
    });
    expect(result.differences).toEqual([]);
    expect(result.equal).toBe(true);
  });

  test("an invalid batch item identifier fails the whole batch, so the message is not deleted", async () => {
    // AWS: an empty or unknown itemIdentifier makes Lambda treat the entire batch as failed.
    const bogus: SqsHandler = async () => ({ batchItemFailures: [{ itemIdentifier: "" }] });
    const log = await replay(
      scenario(),
      createAwsPlatform({ handler: bogus, clients: clients() }),
      {
        seed: 1,
        faults: [],
      },
    );
    expect(selectEffects(log, sqsDelete("payments"))).toHaveLength(0);
    expect(log.entries.some((e) => e.op === "dead_letter")).toBe(true);
    const diff = await runAwsDifferential(scenario(), { handler: bogus, clients: clients() });
    expect(diff.differences).toEqual([]);
    expect(diff.raw.attempts.every((a) => !a.deleted)).toBe(true);
  });

  test("table discovery follows ListTables pagination past 100 tables", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `many-${String(i).padStart(3, "0")}`);
    for (const name of many) {
      await rawSend(
        local,
        new CreateTableCommand({
          TableName: name,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        }),
      );
    }
    const firstPage = await rawSend<{ TableNames?: string[] }>(local, new ListTablesCommand({}));
    expect(firstPage.TableNames?.length).toBe(100);
    const all = await listAllTables(local);
    expect(all).toEqual(expect.arrayContaining(many));
    // The scenario's table sorts after the page boundary; reset must still find and replace it.
    const late = dynamoTable("zz-payments", { name: "pk", type: "S" });
    await resetTables(local, [late]);
    await resetTables(local, [late]);
    expect(await listAllTables(local)).toContain("zz-payments");
  });

  test("a client class without a local counterpart is UNSUPPORTED, and send is restored after the run", async () => {
    const viaDoc: SqsHandler = async () => {
      await remoteDoc.send(
        new PutCommand({ TableName: "payments", Item: { pk: "payment", sk: "x" } }),
      );
    };
    // Only the base client is given, so the handler's DocumentClient has no local counterpart.
    const verdict = await explore(
      scenario(),
      createAwsPlatform({ handler: viaDoc, clients: { DynamoDBClient: local } }),
      { seed: 1, maxRuns: 1, now: () => 0 },
    );
    expect(verdict.kind).toBe("UNSUPPORTED");
    if (verdict.kind === "UNSUPPORTED") expect(verdict.reason).toContain("DynamoDBDocumentClient");
    expect(Client.prototype.send).toBe(originalSend);
  });

  test("replays are byte-identical, with randomUUID and Date.now in the records virtualised", async () => {
    const a = await replay(scenario(), createAwsPlatform({ handler: buggy, clients: clients() }), {
      seed: 9,
      faults: [],
    });
    const b = await replay(scenario(), createAwsPlatform({ handler: buggy, clients: clients() }), {
      seed: 9,
      faults: [],
    });
    expect(digestLog(a)).toBe(digestLog(b));
  });
});

describe("state invariants and the differential", () => {
  test("everyRow over the snapshot and the differential agree for the fixed handler", async () => {
    const spec = scenario({
      invariants: [
        {
          kind: "everyRow",
          name: "amounts-positive",
          query: dynamoRows("payments"),
          holds: [{ column: "amount_cents", op: "gt", value: 0 }],
        },
      ],
    });
    const verdict = await explore(spec, createAwsPlatform({ handler: fixed, clients: clients() }), {
      seed: 2,
      maxRuns: 5,
      faultProbability: 0,
      now: () => 0,
    });
    expect(verdict.kind).toBe("BOUNDED");
    const diff = await runAwsDifferential(spec, { handler: fixed, clients: clients() });
    expect(diff.differences).toEqual([]);
    expect(diff.equal).toBe(true);
    expect(diff.raw.attempts.map((a) => a.deleted)).toEqual([true, true]);
    expect(diff.eutaxy.tables["payments"]).toHaveLength(2);
  });

  test("a read is recorded with its summary and does not count as a write", async () => {
    const reader: SqsHandler = async () => {
      await remote.send(
        new GetItemCommand({
          TableName: "payments",
          Key: { pk: { S: "payment" }, sk: { S: "none" } },
        }),
      );
    };
    const log = await replay(
      scenario({ drive: sqs("payments", [{ body: { orderId: "o-1", amountCents: 1 } }]) }),
      createAwsPlatform({ handler: reader, clients: clients() }),
      { seed: 1, faults: [] },
    );
    const get = log.entries.find((e) => e.kind === "result" && e.op === "GetItem");
    expect(get?.payload).toMatchObject({ result: { found: false } });
  });
});
