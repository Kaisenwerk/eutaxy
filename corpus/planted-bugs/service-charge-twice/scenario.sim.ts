import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Schema,
  defineScenario,
  queue,
  service,
  serviceCall,
} from "eutaxy/cloudflare";

const orders = queue("orders", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "service-charge-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.sql"),
    // The billing Worker, scripted: every charge succeeds.
    service("BILLING", { methods: { charge: { returns: { chargeId: "ch-1" } } } }),
  ],
  drive: orders,
  invariants: [
    // The bug: a redelivery after a lost answer charges the same order again.
    atMostOncePerKey("charged-once", serviceCall("BILLING", "charge"), "args.args.0"),
    // Holds: every order is charged at least once.
    atLeastOncePerMessage(
      "every-order-charged",
      orders,
      serviceCall("BILLING", "charge"),
      "args.args.0",
      "orderId",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
