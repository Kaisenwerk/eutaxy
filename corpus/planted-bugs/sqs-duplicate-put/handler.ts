/**
 * A Lambda consuming a payments SQS queue and recording each payment in
 * DynamoDB. Clients live at module scope, as Lambda code does.
 *
 * Planted bug: every record is written under a fresh random sort key, so a
 * redelivered message (the function died after the write but before Lambda
 * deleted the message) records the order twice. Nothing is wrong with the
 * write itself; the key choice makes retries unsafe.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { SQSHandler } from "aws-lambda";

const client = new DynamoDBClient({});

export interface Payment {
  readonly orderId: string;
  readonly amountCents: number;
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const { orderId, amountCents } = JSON.parse(record.body) as Payment;
    await client.send(
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

export default handler;
