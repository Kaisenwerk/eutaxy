import {
  d1Param,
  d1Read,
  d1Schema,
  d1Write,
  defineScenario,
  http,
  refines,
} from "eutaxy/cloudflare";

// Two partial refunds of one order, sent at once from an admin screen; the browser does not resend.
const refunds = http(
  [
    { path: "/refunds", body: { orderId: "o-1", amountCents: 600 } },
    { path: "/refunds", body: { orderId: "o-1", amountCents: 400 } },
  ],
  { retries: 0 },
);

export default defineScenario({
  name: "refund-lost-update",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: refunds,
  // The core's calls are recorded as decisions, and its Lemma specs are checked on them.
  specs: ["./domain.ts"],
  invariants: [
    // The bug: the second write carries out a decision made on a total the first write had changed.
    refines("refund-follows-decision", "decideRefund", d1Write("DB"), {
      follows: [{ effect: d1Param(1), decision: "result.refunded" }],
      state: { read: d1Read("DB"), write: d1Write("DB"), key: d1Param(0) },
    }),
  ],
  // No faults: the interleaving alone loses the update.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
