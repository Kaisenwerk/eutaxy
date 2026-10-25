import {
  d1Rows,
  d1Schema,
  defineScenario,
  http,
  r2Bucket,
  r2Rows,
  references,
} from "eutaxy/cloudflare";

// The client resends an upload it got no 2xx for, up to twice.
const uploads = http(
  [
    { path: "/attachments", body: { messageId: "m-1", name: "notes.txt", text: "first draft" } },
    { path: "/attachments", body: { messageId: "m-2", name: "plan.txt", text: "ship it" } },
  ],
  { retries: 2 },
);

export default defineScenario({
  name: "r2-orphaned-upload",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql"), r2Bucket("FILES")],
  drive: uploads,
  invariants: [
    // The bug: an object written before a row that never came.
    references(
      "every-object-recorded",
      r2Rows("FILES"),
      "key",
      d1Rows("DB", "attachments"),
      "object_key",
    ),
    // Holds: the row is written only after its object is.
    references(
      "every-row-has-object",
      d1Rows("DB", "attachments"),
      "object_key",
      r2Rows("FILES"),
      "key",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
