import { describe, expect, test } from "vitest";
import { toJson } from "./json.ts";
import { normalizeOp, summarize, tablesOf, targetOf } from "./sdk.ts";

describe("toJson", () => {
  test("keeps binary contents so two different binary keys stay distinct", () => {
    expect(toJson(new Uint8Array([1]))).not.toEqual(toJson(new Uint8Array([2])));
    expect(toJson(new Uint8Array([1, 2, 3]))).toBe("base64:AQID");
  });
});

describe("normalizeOp", () => {
  test("maps DocumentClient commands onto the low-level names", () => {
    expect(normalizeOp("PutCommand")).toBe("PutItem");
    expect(normalizeOp("GetCommand")).toBe("GetItem");
    expect(normalizeOp("BatchWriteCommand")).toBe("BatchWriteItem");
    expect(normalizeOp("TransactWriteCommand")).toBe("TransactWriteItems");
    expect(normalizeOp("QueryCommand")).toBe("Query");
    expect(normalizeOp("PutItemCommand")).toBe("PutItem");
  });
});

describe("targetOf", () => {
  test("names the table for single-table commands and every table for batches and transactions", () => {
    expect(targetOf("DynamoDB", "PutItem", { TableName: "payments" })).toBe("DynamoDB:payments");
    expect(
      targetOf("DynamoDB", "BatchWriteItem", { RequestItems: { payments: [], audit: [] } }),
    ).toBe("DynamoDB:audit+payments");
    expect(
      targetOf("DynamoDB", "TransactWriteItems", {
        TransactItems: [
          { Put: { TableName: "payments" } },
          { ConditionCheck: { TableName: "accounts" } },
          { Delete: { TableName: "payments" } },
        ],
      }),
    ).toBe("DynamoDB:accounts+payments");
    expect(tablesOf("BatchGetItem", { RequestItems: { a: {} } })).toEqual(["a"]);
    expect(targetOf("DynamoDB", "ListTables", {})).toBe("DynamoDB");
    expect(
      targetOf("SQS", "SendMessage", { QueueUrl: "https://sqs.local/000000000000/payments" }),
    ).toBe("SQS:payments");
  });
});

describe("summarize", () => {
  test("reports writes, reads and unprocessed batch items", () => {
    expect(summarize("PutItem", {})).toEqual({ written: 1 });
    expect(summarize("GetItem", { Item: {} })).toEqual({ found: true });
    expect(summarize("GetItem", {})).toEqual({ found: false });
    expect(summarize("Query", { Count: 3 })).toEqual({ count: 3 });
    const two = { RequestItems: { payments: [{}, {}] } };
    expect(summarize("BatchWriteItem", { UnprocessedItems: {} }, two)).toEqual({
      written: 2,
      unprocessed: 0,
    });
    // Partial success: one of two committed still counts as a write.
    expect(summarize("BatchWriteItem", { UnprocessedItems: { payments: [{}] } }, two)).toEqual({
      written: 1,
      unprocessed: 1,
    });
    expect(summarize("DescribeTable", {})).toEqual({ ok: true });
  });
});
