import {
  atLeastOncePerMessage,
  d1Param,
  d1Rows,
  d1Schema,
  d1Write,
  defineScenario,
  http,
  unique,
} from "eutaxy/cloudflare";

const deposits = http(
  [
    { path: "/webhooks/deposits", body: { id: "evt-1", account: "acct-1", amountCents: 1200 } },
    { path: "/webhooks/deposits", body: { id: "evt-2", account: "acct-1", amountCents: 500 } },
  ],
  { retries: 3 },
);

// The same scenario against the fixed Worker and the schema with the unique event id.
export default defineScenario({
  name: "deposits-fixed",
  worker: { entry: "./worker.fixed.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.fixed.sql")],
  drive: deposits,
  invariants: [
    unique("credited-once", d1Rows("DB", "ledger"), "event_id"),
    atLeastOncePerMessage("every-deposit-credited", deposits, d1Write("DB"), d1Param(0), "id"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 3, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
