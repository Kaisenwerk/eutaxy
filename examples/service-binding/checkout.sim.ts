import { callee, d1Rows, d1Schema, defineScenario, http, unique } from "eutaxy/cloudflare";

export default defineScenario({
  name: "checkout",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    // The payments Worker runs for real in the same simulation; its database is `payments/DB`.
    callee("PAYMENTS", { entry: "./payments/worker.ts", config: "./payments/wrangler.jsonc" }),
    d1Schema("payments/DB", "./payments/schema.sql"),
  ],
  // A client pays two orders and resends a request it got no answer for, up to three times.
  drive: http(
    [
      { path: "/orders/o-1/pay", body: { amountCents: 2500 } },
      { path: "/orders/o-2/pay", body: { amountCents: 900 } },
    ],
    { retries: 3 },
  ),
  invariants: [
    // An order is charged once, whatever the keys.
    unique("one-charge-per-order", d1Rows("payments/DB", "charges"), "order_id"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 3, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
