import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
  workflow,
} from "eutaxy/cloudflare";

/**
 * One turn started through the Workflow, whose start on the object naps
 * `napMs` before answering (0: answers at once), with up to `concurrency`
 * invocations in flight and up to `faults` faults a run.
 */
export const turn = (napMs: number, concurrency: 1 | 2, faults: number) =>
  defineScenario({
    name: `v0-16-step-timeout-nap${napMs}-${concurrency}-f${faults}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [workflow("TURNS", "TurnFlow", { name: "turn-flow" }), durableObject("CHAT", { s: {} })],
    drive: http(
      [{ id: "turn-1", path: `/turn/t-1${napMs > 0 ? `?nap=${napMs}` : ""}`, method: "POST" }],
      { retries: 0 },
    ),
    externals: [
      external("model", "model.example", {
        responses: [{ status: 200, body: { runId: "run-t-1" } }],
      }),
    ],
    invariants: [
      // A turn that was abandoned has no run: a start still in flight when the fence was set is refused.
      everyRow(
        "fenced-turns-never-run",
        {
          ...durableObjectTable("CHAT", "s", "turns"),
          where: [{ column: "fenced", op: "eq", value: 1 }],
        },
        [{ column: "run_id", op: "eq", value: null }],
      ),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      // The step's one retry counts against the redelivery bound.
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 2000,
    },
  });

export default turn(0, 2, 1);
