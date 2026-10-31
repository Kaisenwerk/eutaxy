import {
  atLeastOnce,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  rpc,
  rpcResponse,
  service,
  unique,
  workflow,
  workflowRows,
} from "eutaxy/cloudflare";

// The storefront, a Worker calling over a service binding: it resends a call that threw or got no answer once.
const storefront = rpc(
  [
    { method: "placeOrder", args: ["o-1", "sku-1"] },
    { method: "placeOrder", args: ["o-2", "sku-2"] },
    { method: "confirmShipment", args: ["o-1", "trk-1"] },
    { method: "confirmShipment", args: ["o-2", "trk-2"] },
  ],
  { entrypoint: "Orders", retries: 1 },
);

export default defineScenario({
  name: "orders-over-rpc",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    d1Schema("DB", "./schema.sql"),
    // The logistics partner, scripted: one price, and no shipment it knows of on its own.
    service("PARTNER", {
      methods: { quote: { returns: { priceCents: 1200 } }, shipment: { returns: null } },
    }),
    workflow("FULFILMENT", "Fulfilment"),
  ],
  drive: storefront,
  invariants: [
    // The caller never gives up: every call gets an answer that is not an error, resends included.
    atLeastOnce(
      "every-order-placed-ok",
      rpcResponse("placeOrder", { entrypoint: "Orders", ok: true }),
      "args.callId",
      ["call-1", "call-2"],
    ),
    atLeastOnce(
      "every-confirmation-ok",
      rpcResponse("confirmShipment", { entrypoint: "Orders", ok: true }),
      "args.callId",
      ["call-3", "call-4"],
    ),
    unique("one-fulfilment-per-order", workflowRows("FULFILMENT"), "params.orderId"),
    everyRow("every-order-shipped", d1Rows("DB", "orders"), [
      { column: "status", op: "eq", value: "shipped" },
      { column: "tracking_id", op: "notNull" },
    ]),
    everyRow("every-order-priced", d1Rows("DB", "orders"), [
      { column: "price_cents", op: "gte", value: 1 },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
