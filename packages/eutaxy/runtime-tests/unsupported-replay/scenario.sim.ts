import { d1Rows, d1Schema, defineScenario, queue, unique } from "eutaxy/cloudflare";

export default defineScenario({
  name: "unsupported-replay",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: queue("orders", [{ body: { orderId: "o-1" } }]),
  invariants: [unique("one-row-per-order", d1Rows("DB", "orders"), "order_id")],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
