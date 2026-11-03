import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "inventory-oversell-sqlite",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // The store's stock table holds one widget.
  setup: [
    durableObject(
      "INVENTORY",
      {},
      {
        sql: {
          "store-1": {
            schema: "CREATE TABLE stock (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL)",
            rows: { stock: [{ sku: "widget", qty: 1 }] },
          },
        },
      },
    ),
  ],
  // Two reservations of the widget arrive at once; the caller does not resend.
  drive: http(
    [
      { path: "/reserve", body: { sku: "widget", qty: 1 } },
      { path: "/reserve", body: { sku: "widget", qty: 1 } },
    ],
    { retries: 0 },
  ),
  externals: [external("warehouse", "warehouse.example")],
  invariants: [
    // The bug: both reservations pass the stock check while the first awaits the warehouse.
    everyRow("stock-never-negative", durableObjectTable("INVENTORY", "store-1", "stock"), [
      { column: "qty", op: "gte", value: 0 },
    ]),
  ],
  // No faults: the interleaving alone oversells.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
