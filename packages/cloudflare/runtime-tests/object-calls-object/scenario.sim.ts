import {
  defineScenario,
  durableObject,
  durableObjectTable,
  http,
  references,
  unique,
} from "@eutaxy/cloudflare";

const holds = (cart: string) =>
  // An item a cart keeps is a unit its shelf gave that cart.
  references(
    `${cart}-holds-what-the-shelf-gave`,
    durableObjectTable("CART", cart, "items"),
    "holder",
    durableObjectTable("SHELF", "widget", "takes"),
    "cart",
  );

/**
 * Two carts asking one shelf for its only unit, then a look at the first
 * cart. Every call from one object into another, through its own env, is
 * an effect a fault can land on, hosting what the called object does: the
 * cart's into the shelf, the shelf's back into the cart that is waiting on
 * it, the shelf's into the auditor after its answer, the auditor's back
 * into the shelf, and the cart's into itself.
 */
export const carts = (concurrency: 1 | 2, faults: number) =>
  defineScenario({
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
        { id: "look-1", path: "/carts/c1", method: "GET" },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      holds("c1"),
      holds("c2"),
      // What the shelf marked as audited, the auditor has.
      references(
        "audited-takes-are-in-the-log",
        {
          ...durableObjectTable("SHELF", "widget", "takes"),
          where: [{ column: "audited", op: "eq", value: 1 }],
        },
        "cart",
        durableObjectTable("AUDIT", "log", "seen"),
        "cart",
      ),
      // The shelf's one unit has one holder.
      unique("one-unit-one-holder", durableObjectTable("SHELF", "widget", "takes"), "unit"),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default carts(2, 1);
