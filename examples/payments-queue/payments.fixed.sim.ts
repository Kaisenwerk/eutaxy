import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  queue,
} from "eutaxy/cloudflare";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

// The same scenario against the fixed Worker and the schema with the unique order id.
export default defineScenario({
  name: "payments-fixed",
  worker: { entry: "./worker.fixed.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.fixed.sql")],
  drive: payments,
  invariants: [
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
