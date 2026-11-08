import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
  unique,
} from "eutaxy/cloudflare";

/** Two runs are started at once; the object answers each and finishes both after the answers. */
export default defineScenario({
  name: "v0-16-object-work-after-answer",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("RUNNER", { r: {} })],
  drive: http(
    [
      { id: "run-1", path: "/runs/run-1", method: "POST" },
      { id: "run-2", path: "/runs/run-2", method: "POST" },
    ],
    { retries: 0 },
  ),
  externals: [
    external("model", "model.example", { responses: [{ status: 200, body: { steps: 2 } }] }),
  ],
  invariants: [
    everyRow("every-run-finishes", durableObjectTable("RUNNER", "r", "runs"), [
      { column: "status", op: "eq", value: "done" },
    ]),
    // Two jobs cannot bring the object to the same total: a lost update would.
    unique("each-job-reaches-a-new-total", durableObjectTable("RUNNER", "r", "runs"), "total"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
