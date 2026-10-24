/** DynamoDB table reset and end-of-run snapshots, through the real local client (never effects). */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  ListTablesCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { canonicalJson, type JsonValue, type PlatformData, type ScenarioSpec } from "@eutaxy/core";
import { realTick } from "@eutaxy/engine";
import { toJson } from "./json.ts";
import { rawSend } from "./sdk.ts";

export type KeyType = "S" | "N" | "B";

/** A type alias, not an interface, so it satisfies PlatformData's JSON index signature. */
export type KeyDef = { readonly name: string; readonly type: KeyType };

/** A table to create before each run. */
export interface TableSpec extends PlatformData {
  readonly kind: "dynamodb-table";
  readonly name: string;
  readonly partitionKey: KeyDef;
  readonly sortKey?: KeyDef;
}

/** The DynamoDB tables a scenario sets up. */
export function scenarioTables(spec: ScenarioSpec): readonly TableSpec[] {
  return spec.setup.filter((s): s is TableSpec => s.kind === "dynamodb-table");
}

async function waitActive(client: DynamoDBClient, name: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const out = await rawSend<{ Table?: { TableStatus?: string } }>(
      client,
      new DescribeTableCommand({ TableName: name }),
    );
    if (out.Table?.TableStatus === "ACTIVE") return;
    await realTick(); // never the (possibly virtual) setTimeout: reset runs with the globals patched
  }
  throw new Error(`table ${name} did not become ACTIVE`);
}

/** DeleteTable returns before the table is gone; creating it again too early is a ResourceInUseException. */
async function waitGone(client: DynamoDBClient, name: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await rawSend(client, new DescribeTableCommand({ TableName: name }));
    } catch (err) {
      if ((err as { name?: string }).name === "ResourceNotFoundException") return;
      throw err;
    }
    await realTick();
  }
  throw new Error(`table ${name} was not deleted`);
}

/** Every table name, following `LastEvaluatedTableName` past the 100-per-page limit. */
export async function listAllTables(client: DynamoDBClient): Promise<string[]> {
  const names: string[] = [];
  let start: string | undefined;
  do {
    const page = await rawSend<{ TableNames?: string[]; LastEvaluatedTableName?: string }>(
      client,
      new ListTablesCommand(start ? { ExclusiveStartTableName: start } : {}),
    );
    names.push(...(page.TableNames ?? []));
    start = page.LastEvaluatedTableName;
  } while (start);
  return names;
}

/** Drop and recreate the tables, so every run starts from the same empty state. */
export async function resetTables(
  client: DynamoDBClient,
  tables: readonly TableSpec[],
): Promise<void> {
  const present = new Set(await listAllTables(client));
  for (const t of tables) {
    if (present.has(t.name)) {
      await rawSend(client, new DeleteTableCommand({ TableName: t.name }));
      await waitGone(client, t.name);
    }
    const keys = [t.partitionKey, ...(t.sortKey ? [t.sortKey] : [])];
    await rawSend(
      client,
      new CreateTableCommand({
        TableName: t.name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: keys.map((k) => ({ AttributeName: k.name, AttributeType: k.type })),
        KeySchema: [
          { AttributeName: t.partitionKey.name, KeyType: "HASH" },
          ...(t.sortKey ? [{ AttributeName: t.sortKey.name, KeyType: "RANGE" as const }] : []),
        ],
      }),
    );
    await waitActive(client, t.name);
  }
}

/** Every item of every table, unmarshalled and sorted canonically. */
export async function snapshotTables(
  client: DynamoDBClient,
  tables: readonly TableSpec[],
): Promise<{ readonly [table: string]: readonly JsonValue[] }> {
  const out: Record<string, JsonValue[]> = {};
  for (const t of tables) {
    const items: JsonValue[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await rawSend<{
        Items?: Record<string, never>[];
        LastEvaluatedKey?: Record<string, unknown>;
      }>(
        client,
        new ScanCommand({
          TableName: t.name,
          ...(start ? { ExclusiveStartKey: start as never } : {}),
        }),
      );
      for (const item of page.Items ?? []) items.push(toJson(unmarshall(item)));
      start = page.LastEvaluatedKey;
    } while (start);
    out[t.name] = items
      .map((j) => [canonicalJson(j), j] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, j]) => j);
  }
  return out;
}
