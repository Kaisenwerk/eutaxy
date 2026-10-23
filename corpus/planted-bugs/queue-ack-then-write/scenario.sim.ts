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

export default defineScenario({
  name: "queue-ack-then-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    // The bug: acknowledged, then cut off before the write ever starts.
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
    // Holds: the lookup-then-insert is idempotent.
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
