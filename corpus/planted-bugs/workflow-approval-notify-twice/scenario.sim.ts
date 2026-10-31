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
  name: "workflow-approval-notify-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [workflow("APPROVALS", "ApprovalFlow")],
  // One document: the request that starts its approval, then the approver's decision.
  drive: http([
    { path: "/approvals", body: { documentId: "doc-1" } },
    { path: "/decisions", body: { documentId: "doc-1", by: "alice", approved: true } },
  ]),
  externals: [
    // The notification service deduplicates by Idempotency-Key; the planted Workflow sends none.
    external("notify", "notify.example", {
      dedupeBy: "idempotency-key",
      responses: [{ method: "POST", path: "/send", status: 202, body: { queued: true } }],
    }),
  ],
  invariants: [
    // The bug: a restart after the notification replays the stored decision and notifies again.
    atMostOncePerKey("notified-once", fetchCall("notify", "POST"), "args.body.documentId"),
    unique("one-run-per-document", workflowRows("APPROVALS"), "params.documentId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
