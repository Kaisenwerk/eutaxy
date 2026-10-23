import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  defineScenario,
  external,
  fetchCall,
  queue,
} from "eutaxy/cloudflare";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "fetch-idempotent",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: payments,
  externals: [
    external("payments", "api.payments.example", {
      dedupeBy: "Idempotency-Key",
      responses: [
        {
          method: "POST",
          path: "/charges",
          status: 201,
          body: { id: "ch_1", status: "succeeded" },
        },
      ],
    }),
  ],
  invariants: [
    atMostOncePerKey("charged-once", fetchCall("payments", "POST"), "args.body.orderId"),
    atLeastOncePerMessage(
      "every-order-charged",
      payments,
      fetchCall("payments", "POST"),
      "args.body.orderId",
      "orderId",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 3, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
