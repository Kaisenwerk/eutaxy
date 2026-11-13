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

/**
 * Two runs started at once through one of the runner's timings, each
 * passed on by the front object, with up to `concurrency` invocations in
 * flight and up to `faults` faults. Without a fault every run finishes, to
 * a total of its own; under one, whatever the front object noted as
 * answered was answered.
 */
export const nested = (method: Timing, concurrency: 1 | 2, faults = 0) =>
  defineScenario({
    name: `v0-17-nested-object-timing-${method}-${concurrency}-${faults}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [durableObject("RUNNER", { r: {} }), durableObject("FRONT", { f: {} })],
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
    invariants:
      faults === 0
        ? [
            everyRow("every-run-finishes", durableObjectTable("RUNNER", "r", "runs"), [
              { column: "status", op: "eq", value: "done" },
            ]),
            unique(
              "each-job-reaches-a-new-total",
              durableObjectTable("RUNNER", "r", "runs"),
              "total",
            ),
            everyRow("every-pass-is-answered", durableObjectTable("FRONT", "f", "passes"), [
              { column: "answered", op: "eq", value: 1 },
            ]),
          ]
        : [unique("a-run-is-noted-once", durableObjectTable("FRONT", "f", "passes"), "id")],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 0,
      maxConcurrentInvocations: concurrency,
      budgetMs: 2000,
    },
  });

export default nested("slow", 2);
