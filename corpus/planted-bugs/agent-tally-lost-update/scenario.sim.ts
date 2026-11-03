import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "agent-tally-lost-update",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // The Agent instance t-1 starts empty; the SDK creates its own tables.
  setup: [durableObject("TALLY", { "t-1": {} })],
  // Two hits arrive at once; the caller does not resend.
  drive: http(
    [
      { path: "/agents/tally/t-1", body: { hit: 1 } },
      { path: "/agents/tally/t-1", body: { hit: 2 } },
    ],
    { retries: 0 },
  ),
  externals: [external("audit", "audit.example")],
  invariants: [
    // The bug: both hits read a count of 0 while the first awaits the audit, so the flush records 1.
    everyRow("flush-counts-both-hits", durableObjectTable("TALLY", "t-1", "flushes"), [
      { column: "count", op: "eq", value: 2 },
    ]),
  ],
  // No faults: the interleaving alone loses the update.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
