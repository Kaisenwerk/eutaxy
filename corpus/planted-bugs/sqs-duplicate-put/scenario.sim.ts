import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  defineAwsScenario,
  dynamoTable,
  dynamoWrite,
  sqs,
} from "eutaxy/aws";

const payments = sqs("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineAwsScenario({
  name: "sqs-duplicate-put",
  handler: { entry: "./handler.ts", config: "./template.yaml" },
  drive: payments,
  tables: [dynamoTable("payments", { name: "pk", type: "S" }, { name: "sk", type: "S" })],
  invariants: [
    // The bug: a redelivered message writes a second item for the same order.
    atMostOncePerKey("payment-recorded-once", dynamoWrite("payments"), "args.Item.order_id.S"),
    atLeastOncePerMessage(
      "every-payment-recorded",
      payments,
      dynamoWrite("payments"),
      "args.Item.order_id.S",
      "orderId",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
