import {
  cron,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  service,
  unique,
  workflow,
  workflowRows,
} from "eutaxy/cloudflare";

// The reconciliation tick, re-run once when it fails; two orders wait for a confirmation that never came.
const reconcile = cron("*/15 * * * *", { ticks: 1, retries: 1 });

export default defineScenario({
  name: "reconcile-by-cron",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.reconcile.sql"),
    // The partner knows both shipments.
    service("PARTNER", {
      methods: {
        quote: { returns: { priceCents: 1200 } },
        shipment: { returns: { trackingId: "trk-partner" } },
      },
    }),
    workflow("FULFILMENT", "Fulfilment"),
  ],
  drive: reconcile,
  invariants: [
    unique("one-fulfilment-per-order", workflowRows("FULFILMENT"), "params.orderId"),
    everyRow("every-order-shipped", d1Rows("DB", "orders"), [
      { column: "status", op: "eq", value: "shipped" },
      { column: "tracking_id", op: "eq", value: "trk-partner" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
