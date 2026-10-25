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
  name: "workflow-reply-sent-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [workflow("TURNS", "ChatTurn")],
  // One chat message; the chat platform resends it once if it gets no answer.
  drive: http([{ path: "/webhook", body: { messageId: "msg-1", text: "hello" } }], { retries: 1 }),
  externals: [
    external("model", "model.example", {
      responses: [{ method: "POST", path: "/generate", status: 200, body: { reply: "hi there" } }],
    }),
    // The chat API deduplicates by Idempotency-Key; the planted Workflow never sends one.
    external("chat", "chat.example", {
      dedupeBy: "Idempotency-Key",
      responses: [{ method: "POST", status: 200, body: { ok: true } }],
    }),
  ],
  invariants: [
    // The bug: an engine restart after the post runs the reply step again.
    atMostOncePerKey("reply-sent-once", fetchCall("chat", "POST"), "args.body.messageId"),
    unique("one-run-per-message", workflowRows("TURNS"), "params.messageId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 4000 },
});
