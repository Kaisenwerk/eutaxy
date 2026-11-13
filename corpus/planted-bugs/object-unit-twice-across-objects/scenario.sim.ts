import { defineScenario, durableObject, durableObjectTable, http, unique } from "eutaxy/cloudflare";

/** The scenario over one of the two shelves: the planted one (`SHELF`) or the fixed one (`SAFE_SHELF`). */
export const takes = (binding: "SHELF" | "SAFE_SHELF") =>
  defineScenario({
    name: `object-unit-twice-across-objects${binding === "SAFE_SHELF" ? "-fixed" : ""}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("CART", { c1: {} }), durableObject(binding, { widget: {} })],
    // The client resends a request it got no answer for, once.
    drive: http(
      [
        {
          id: "add-1",
          path: `/carts/c1/widget${binding === "SAFE_SHELF" ? "?fixed" : ""}`,
          method: "POST",
        },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // The bug: a cart whose first take it did not get to keep is given a second unit.
      unique("one-unit-a-cart", durableObjectTable(binding, "widget", "takes"), "cart"),
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 1, maxConcurrentInvocations: 1, budgetMs: 4000 },
  });

export default takes("SHELF");
