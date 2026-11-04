import {
  callee,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  queue,
  references,
  unique,
} from "eutaxy/cloudflare";

const orders = queue("orders", [
  { body: { orderId: "o-1", sku: "sku-1", qty: 1 } },
  { body: { orderId: "o-2", sku: "sku-2", qty: 2 } },
]);

export default defineScenario({
  name: "callee-reserve-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.sql"),
    // The inventory Worker, for real: its code runs in this simulation, its database under its name.
    callee("INVENTORY", { entry: "./inventory/worker.ts", config: "./inventory/wrangler.jsonc" }),
    d1Schema("inventory/DB", "./inventory/schema.sql"),
  ],
  drive: orders,
  invariants: [
    // The bug: a redelivery after a lost answer reserves the same order again, under a new key.
    unique("one-reservation-per-order", d1Rows("inventory/DB", "reservations"), "order_id"),
    // Hold: every order recorded holds a reservation, and one the inventory Worker knows.
    everyRow("every-order-reserved", d1Rows("DB", "orders"), [
      { column: "reservation_id", op: "notNull" },
    ]),
    references(
      "every-order-holds-a-reservation",
      d1Rows("DB", "orders"),
      "reservation_id",
      d1Rows("inventory/DB", "reservations"),
      "reservation_id",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
