import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
  unique,
} from "eutaxy/cloudflare";

export type Timing = "slow" | "eager" | "hashed";

/** Two runs started at once through one of the object's timings, with up to `concurrency` calls in flight. */
export const timing = (method: Timing, concurrency: 1 | 2) =>
  defineScenario({
    name: `v0-16-object-timing-${method}-${concurrency}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("RUNNER", { r: {} })],
    drive: http(
      [
        { id: "run-1", path: `/${method}/run-1`, method: "POST" },
        { id: "run-2", path: `/${method}/run-2`, method: "POST" },
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
      unique("each-job-reaches-a-new-total", durableObjectTable("RUNNER", "r", "runs"), "total"),
    ],
    bounds: {
      maxFaultsPerRun: 0,
      maxRedeliveries: 0,
      maxConcurrentInvocations: concurrency,
      budgetMs: 2000,
    },
  });

export default timing("eager", 2);
