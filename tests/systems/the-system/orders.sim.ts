import {
  callee,
  d1Rows,
  d1Schema,
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  queue,
  references,
  unique,
  workflow,
  workflowRows,
} from "eutaxy/cloudflare";

// Two orders of one sku, delivered concurrently: both Workers' code runs for real, the stock object shared.
const orders = queue("orders", [
  { body: { orderId: "o-1", sku: "sku-1", qty: 2 } },
  { body: { orderId: "o-2", sku: "sku-1", qty: 3 } },
]);

export default defineScenario({
  name: "the-system",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.sql"),
    callee("INVENTORY", { entry: "./inventory/worker.ts", config: "./inventory/wrangler.jsonc" }),
    d1Schema("inventory/DB", "./inventory/schema.sql"),
    // The stock objects: the storefront's binding names the namespace both Workers use (inventory/STOCK is its alias).
    durableObject("STOCK"),
    workflow("inventory/FULFILMENT", "Fulfilment", { name: "fulfilment" }),
  ],
  drive: orders,
  invariants: [
    unique("one-reservation-per-order", d1Rows("inventory/DB", "reservations"), "order_id"),
    everyRow("every-order-recorded-once", d1Rows("DB", "orders"), [
      { column: "reservation_id", op: "notNull" },
    ]),
    references(
      "every-order-holds-its-reservation",
      d1Rows("DB", "orders"),
      "reservation_id",
      d1Rows("inventory/DB", "reservations"),
      "reservation_id",
    ),
    everyRow("stock-never-negative", durableObjectTable("STOCK", "sku-1", "stock"), [
      { column: "available", op: "gte", value: 0 },
    ]),
    unique("one-fulfilment-per-order", workflowRows("inventory/FULFILMENT"), "params.orderId"),
    everyRow("every-reservation-fulfilled", d1Rows("inventory/DB", "reservations"), [
      { column: "status", op: "eq", value: "fulfilled" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 2, budgetMs: 4000 },
});
