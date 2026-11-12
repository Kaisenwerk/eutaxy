import { d1Rows, d1Schema, defineScenario, durableObject, http, unique } from "eutaxy/cloudflare";

/** The scenario over one of the two objects: the planted one (`ACCOUNT`) or the fixed one (`SAFE_ACCOUNT`). */
export const deposits = (binding: "ACCOUNT" | "SAFE_ACCOUNT") =>
  defineScenario({
    name: `object-entry-twice-across-crash${binding === "SAFE_ACCOUNT" ? "-fixed" : ""}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [d1Schema("LEDGER", "./schema.sql"), durableObject(binding, { "acct-1": {} })],
    // The client resends a deposit it got no answer for, once.
    drive: http(
      [
        {
          id: "dep-1",
          path: `/deposits/dep-1${binding === "SAFE_ACCOUNT" ? "?fixed" : ""}`,
          method: "POST",
          body: { amountCents: 500 },
        },
        {
          id: "dep-2",
          path: `/deposits/dep-2${binding === "SAFE_ACCOUNT" ? "?fixed" : ""}`,
          method: "POST",
          body: { amountCents: 250 },
        },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // The bug: an entry the object did not get to record is written again by the resend.
      unique("entered-once", d1Rows("LEDGER", "entries"), "deposit_id"),
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 1, maxConcurrentInvocations: 1, budgetMs: 4000 },
  });

export default deposits("ACCOUNT");
