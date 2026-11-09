import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
  workflow,
} from "eutaxy/cloudflare";

/** The scenario over one of the two objects: the planted one (`CHAT`) or the fixed one (`SAFE_CHAT`). */
export const turn = (binding: "CHAT" | "SAFE_CHAT") =>
  defineScenario({
    name: `workflow-late-attempt-fenced-turn${binding === "SAFE_CHAT" ? "-fixed" : ""}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      workflow("TURNS", "TurnFlow", { name: "turn-flow" }),
      durableObject(binding, { c: {} }),
    ],
    // One chat turn; the Workflow instance is keyed by its id.
    drive: http(
      [
        {
          id: "turn-1",
          path: `/turn/t-1${binding === "SAFE_CHAT" ? "?fixed" : ""}`,
          method: "POST",
        },
      ],
      { retries: 0 },
    ),
    externals: [
      external("model", "model.example", {
        responses: [{ status: 200, body: { runId: "run-t-1" } }],
      }),
    ],
    invariants: [
      // The bug: a start that passed the fence check before the model call writes its run after the
      // turn was abandoned.
      everyRow(
        "fenced-turns-never-run",
        {
          ...durableObjectTable(binding, "c", "turns"),
          where: [{ column: "fenced", op: "eq", value: 1 }],
        },
        [{ column: "run_id", op: "eq", value: null }],
      ),
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 4000 },
  });

export default turn("CHAT");
