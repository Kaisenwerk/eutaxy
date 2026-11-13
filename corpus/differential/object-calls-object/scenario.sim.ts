import {
  defineScenario,
  durableObject,
  durableObjectTable,
  http,
  references,
} from "eutaxy/cloudflare";

/** Two carts ask one shelf for its only unit, the first of them twice, and the second asks who holds it. */
export default defineScenario({
  name: "object-calls-object",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    durableObject("CART", { c1: {}, c2: {} }),
    durableObject("SHELF", { widget: {} }),
    durableObject("AUDIT", { log: {} }),
  ],
  drive: http(
    [
      { id: "add-1", path: "/carts/c1/widget", method: "POST" },
      { id: "add-2", path: "/carts/c2/widget", method: "POST" },
      { id: "add-3", path: "/carts/c1/widget", method: "POST" },
      { id: "who-1", path: "/carts/c2/widget", method: "GET" },
    ],
    { retries: 0 },
  ),
  externals: [],
  invariants: [
    references(
      "c1-holds-what-the-shelf-gave",
      durableObjectTable("CART", "c1", "items"),
      "holder",
      durableObjectTable("SHELF", "widget", "takes"),
      "cart",
    ),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
