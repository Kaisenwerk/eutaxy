/** Runs in Node against an in-process DynamoDB (dynalite); the handler's own client never reaches the network. */
import type { Server } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import dynalite from "dynalite";
import { explore, renderText } from "eutaxy";
import { createAwsPlatform, type SqsHandler } from "eutaxy/aws";
import { afterAll, beforeAll, expect, test } from "vitest";
import handler from "./handler.ts";
import manifest from "./manifest.json";
import scenario from "./scenario.sim.ts";

let server: Server;
let local: DynamoDBClient;

beforeAll(async () => {
  server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  local = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
});

afterAll(async () => {
  local.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test(`reaches ${manifest.expect.verdict} on ${manifest.expect.invariant}`, async () => {
  const platform = createAwsPlatform({
    handler: handler as unknown as SqsHandler,
    clients: { DynamoDBClient: local },
  });
  const verdict = await explore(scenario, platform, { seed: "corpus" });
  expect(verdict.kind, renderText(verdict)).toBe(manifest.expect.verdict);
  if (verdict.kind !== "VIOLATED") return;
  expect(verdict.violation.invariant).toBe(manifest.expect.invariant);
  const puts = verdict.trace.entries.filter(
    (e) => e.kind === "result" && e.target === "DynamoDB:payments" && e.op === "PutItem",
  );
  expect(puts).toHaveLength(2);
  expect(verdict.keptEvents).toHaveLength(1);
  expect(verdict.assumptions.join("\n")).toContain("Lambda with an SQS event source");
}, 120_000);
