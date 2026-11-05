import {
  atMostOncePerKey,
  defineScenario,
  external,
  fetchCall,
  http,
  unique,
  workflow,
  workflowRows,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "expenses-fixed",
  worker: { entry: "./worker.fixed.ts", config: "./wrangler.jsonc" },
  setup: [workflow("APPROVALS", "ExpenseApproval")],
  // An employee submits an expense; later the manager approves it.
  drive: http([
    { path: "/expenses", body: { expenseId: "exp-1", employee: "e-7", amountCents: 4200 } },
    { path: "/expenses/exp-1/decision", body: { approved: true, by: "m-1" } },
  ]),
  externals: [
    // The payouts API deduplicates by Idempotency-Key, as payment APIs do; the planted Workflow sends none.
    external("payouts", "payouts.example", {
      dedupeBy: "idempotency-key",
      responses: [{ method: "POST", path: "/payouts", status: 201, body: { payoutId: "po-1" } }],
    }),
  ],
  invariants: [
    // An approved expense is paid once.
    atMostOncePerKey("paid-once", fetchCall("payouts", "POST"), "args.body.expenseId"),
    // And it has one approval run.
    unique("one-run-per-expense", workflowRows("APPROVALS"), "params.expenseId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
