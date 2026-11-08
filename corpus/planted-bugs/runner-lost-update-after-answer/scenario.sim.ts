import {
  defineScenario,
  durableObject,
  durableObjectTable,
  external,
  http,
  unique,
} from "eutaxy/cloudflare";

/** Two jobs are started at once on one object; each adds two steps to the total after its answer. */
export default defineScenario({
  name: "runner-lost-update-after-answer",
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
    // The bug: the second job's read runs while the first awaits the model, both bring the total to 2.
    unique("each-job-reaches-a-new-total", durableObjectTable("RUNNER", "r", "runs"), "total"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
