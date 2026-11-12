import {
  callee,
  d1Rows,
  d1Schema,
  defineScenario,
  durableObject,
  everyRow,
  http,
  service,
  unique,
  workflow,
} from "eutaxy/cloudflare";

/**
 * Two requests through both Workers' real code. The turns Worker's object
 * calls the model (scripted) and then calls back into the front Worker,
 * the scenario's own, whose notices entrypoint wakes the Workflow's wait.
 * `sure` is for a run with no faults: every reply then comes by the event.
 * `entry` picks the front Worker: the one that takes a notice once, or the
 * planted one that records every notice it is sent.
 */
export const requests = (
  concurrency: 1 | 2,
  faults: number,
  sure = false,
  entry: "./worker.ts" | "./worker.planted.ts" = "./worker.ts",
) =>
  defineScenario({
    name: `v0-17-callback${entry === "./worker.ts" ? "" : "-planted"}${sure ? "" : "-faulted"}`,
    worker: { entry, config: "./wrangler.jsonc" },
    setup: [
      d1Schema("DB", "./schema.sql"),
      workflow("REQUESTS", "RequestFlow", { name: "request-flow" }),
      callee("TURNS", { entry: "./turns/worker.ts", config: "./turns/wrangler.jsonc" }),
      durableObject("turns/TURN"),
      service("turns/MODEL", { methods: { complete: { returns: { reply: "planned" } } } }),
      // The turns Worker's binding back to this Worker: the scenario's own code, called in turn.
      callee("turns/FRONT", { entry, config: "./wrangler.jsonc" }),
    ],
    drive: http(
      [
        { id: "req-1", path: "/requests/req-1", method: "POST" },
        { id: "req-2", path: "/requests/req-2", method: "POST" },
      ],
      { retries: 0 },
    ),
    externals: [],
    invariants: [
      unique("one-reply-per-request", d1Rows("DB", "replies"), "request_id"),
      // A notice sent twice is taken once: the turns Worker resends one it got no answer for.
      unique("one-notice-per-request", d1Rows("DB", "notices"), "request_id"),
      // A reply that came by the event is the model's.
      everyRow(
        "a-reply-by-event-is-the-models",
        { ...d1Rows("DB", "replies"), where: [{ column: "via", op: "eq", value: "event" }] },
        [{ column: "reply", op: "eq", value: "planned" }],
      ),
      // With nothing going wrong the Workflow never has to ask: the callback wakes it.
      ...(sure
        ? [
            everyRow("every-reply-came-by-the-event", d1Rows("DB", "replies"), [
              { column: "via", op: "eq", value: "event" },
            ]),
          ]
        : []),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default requests(2, 0, true);
