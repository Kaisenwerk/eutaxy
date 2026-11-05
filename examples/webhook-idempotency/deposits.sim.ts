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

// The provider posts two deposits and resends any it got no 2xx for, up to three times.
const deposits = http(
  [
    { path: "/webhooks/deposits", body: { id: "evt-1", account: "acct-1", amountCents: 1200 } },
    { path: "/webhooks/deposits", body: { id: "evt-2", account: "acct-1", amountCents: 500 } },
  ],
  { retries: 3 },
);

export default defineScenario({
  name: "deposits",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: deposits,
  invariants: [
    // No event may credit the account twice: one ledger row per event id.
    unique("credited-once", d1Rows("DB", "ledger"), "event_id"),
    // And no event may be lost: its id is the first parameter of the committed credit.
    atLeastOncePerMessage("every-deposit-credited", deposits, d1Write("DB"), d1Param(0), "id"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 3, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
