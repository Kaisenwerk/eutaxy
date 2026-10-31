import {
  atMostOncePerKey,
  cron,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  external,
  fetchCall,
} from "eutaxy/cloudflare";

// One tick; the operator has failed ticks re-run once.
const reconcile = cron("*/5 * * * *", { ticks: 1, retries: 1 });

export default defineScenario({
  name: "cron-dispatch-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: reconcile,
  externals: [
    external("dispatcher", "dispatcher.example", {
      responses: [{ method: "POST", path: "/v1/dispatch", status: 202, body: { accepted: true } }],
    }),
  ],
  invariants: [
    // The bug: the re-run dispatches a row the crashed tick had already dispatched.
    atMostOncePerKey("dispatched-once", fetchCall("dispatcher", "POST"), "args.body.dispatchId"),
    // Holds: once the tick or its re-run completes, every row is sent.
    everyRow("all-sent", d1Rows("DB", "dispatches"), [
      { column: "status", op: "eq", value: "sent" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 1, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
