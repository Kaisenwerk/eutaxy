import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
  stepFaults,
  workflow,
} from "eutaxy/cloudflare";

/**
 * The scenario over one of the two objects, the planted one (`CHAT`) or the fixed one (`SAFE_CHAT`);
 * `sited`: its faults go only on the attempts of the step that starts the turn.
 */
export const turn = (binding: "CHAT" | "SAFE_CHAT", sited: boolean) =>
  defineScenario({
    name: `workflow-fence-after-every-attempt${binding === "SAFE_CHAT" ? "-fixed" : ""}${sited ? "" : "-anywhere"}`,
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
      external("context", "context.example", { responses: [{ status: 200, body: { ok: "ctx" } }] }),
      external("quota", "quota.example", { responses: [{ status: 200, body: { ok: "ok" } }] }),
      external("channels", "channels.example", {
        responses: [{ status: 200, body: { ok: "sent" } }],
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
    bounds: {
      maxFaultsPerRun: 3,
      maxRedeliveries: 2,
      maxConcurrentInvocations: 2,
      budgetMs: 4000,
      // The bug needs a fault on each of the three attempts: here, faults go nowhere else.
      ...(sited ? { faultsAt: [stepFaults("TURNS", "start turn")] } : {}),
    },
  });

export default turn("CHAT", true);
/** The same scenario with faults anywhere, which sampling does not reach the bug in. */
export const anywhere = turn("CHAT", false);
