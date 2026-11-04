import {
  atMostOncePerKey,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  queue,
  service,
  serviceCall,
} from "eutaxy/cloudflare";

const orders = queue("orders", [
  { body: { orderId: "o-1", sku: "sku-1", qty: 1 } },
  { body: { orderId: "o-2", sku: "sku-2", qty: 2 } },
]);

/**
 * The same storefront with the inventory Worker scripted, as v0.10 checks it:
 * every reserve succeeds. The invariants a caller alone can state hold (each
 * key is used once, every order holds a reservation), so the bug is missed.
 */
export default defineScenario({
  name: "callee-reserve-twice-scripted",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.sql"),
    service("INVENTORY", { methods: { reserve: { returns: { reservationId: "r-scripted" } } } }),
  ],
  drive: orders,
  invariants: [
    atMostOncePerKey("one-call-per-key", serviceCall("INVENTORY", "reserve"), "args.args.0"),
    everyRow("every-order-reserved", d1Rows("DB", "orders"), [
      { column: "reservation_id", op: "notNull" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
