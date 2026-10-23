import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  queue,
} from "eutaxy/cloudflare";

// The messages the queue will deliver. Eutaxy explores crashes, retries and
// lost replies around every effect the Worker performs while handling them.
const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "payments",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    // No order may be recorded twice: the first bound parameter of each committed insert is the order id.
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    // And no order may be lost.
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
