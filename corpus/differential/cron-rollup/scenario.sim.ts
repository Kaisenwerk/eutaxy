import { cron, d1Rows, d1Schema, defineScenario, everyRow, unique } from "eutaxy/cloudflare";

// Three ticks, each re-run up to twice when its handler fails.
const rollup = cron("*/10 * * * *", { ticks: 3, retries: 2 });

export default defineScenario({
  name: "cron-rollup",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: rollup,
  invariants: [
    unique("one-rollup-per-tick", d1Rows("DB", "rollups"), "tick"),
    everyRow("rollups-count-something", d1Rows("DB", "rollups"), [
      { column: "n", op: "gte", value: 2 },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
