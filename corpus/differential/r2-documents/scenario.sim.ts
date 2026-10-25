import { defineScenario, everyRow, http, r2Bucket, r2Rows, unique } from "eutaxy/cloudflare";

export default defineScenario({
  name: "r2-documents",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    r2Bucket("FILES", { "docs/readme": { value: "seeded", customMetadata: { id: "readme" } } }),
  ],
  drive: http(
    [
      { method: "POST", path: "/docs", body: { id: "a", text: "first" } },
      { method: "POST", path: "/docs", body: { id: "b", text: "second" } },
      { method: "POST", path: "/docs", body: { id: "a", text: "first, again" } },
    ],
    { retries: 2 },
  ),
  invariants: [
    unique("one-object-per-key", r2Rows("FILES"), "key"),
    everyRow("no-empty-documents", r2Rows("FILES"), [{ column: "size", op: "gte", value: 1 }]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
