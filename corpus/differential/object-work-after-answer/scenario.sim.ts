import {
  defineScenario,
  durableObject,
  durableObjectTable,
  external,
  http,
  unique,
} from "eutaxy/cloudflare";

/** Two runs are started one after the other; the object answers each and finishes the job after it. */
export default defineScenario({
  name: "object-work-after-answer",
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
    unique("each-job-reaches-a-new-total", durableObjectTable("RUNNER", "r", "runs"), "total"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
