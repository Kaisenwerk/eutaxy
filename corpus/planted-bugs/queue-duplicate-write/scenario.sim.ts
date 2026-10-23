import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Rows,
  d1Schema,
  d1Write,
  defineScenario,
  implies,
  queue,
  queueAck,
} from "@eutaxy/cloudflare";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "queue-duplicate-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    // The bug: a redelivered message records the same order twice.
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    // And the fix must not lose anything either.
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
    // Holds even with the bug: an acknowledged message always has its row (one too many, but there).
    implies(
      "acked-has-row",
      queueAck("payments"),
      "args.body.orderId",
      d1Rows("DB", "payments"),
      "order_id",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
