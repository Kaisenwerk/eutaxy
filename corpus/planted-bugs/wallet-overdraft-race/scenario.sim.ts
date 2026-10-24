import {
  defineScenario,
  durableObject,
  durableObjectRows,
  everyRow,
  external,
  http,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "wallet-overdraft-race",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // Alice's wallet holds 100.
  setup: [durableObject("WALLET", { alice: { balance: 100 } })],
  // Two withdrawals of 70 arrive at once; the caller does not resend.
  drive: http(
    [
      { path: "/withdraw", body: { amount: 70 } },
      { path: "/withdraw", body: { amount: 70 } },
    ],
    { retries: 0 },
  ),
  externals: [external("payouts", "payouts.example")],
  invariants: [
    // The bug: both withdrawals pass the check while the first awaits its payout.
    everyRow(
      "balance-never-negative",
      durableObjectRows("WALLET", "alice", [{ column: "key", op: "eq", value: "balance" }]),
      [{ column: "value", op: "gte", value: 0 }],
    ),
  ],
  // No faults: the interleaving alone overdraws the wallet.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
