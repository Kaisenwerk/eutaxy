import {
  d1Rows,
  d1Schema,
  defineScenario,
  durableObject,
  http,
  r2Bucket,
  r2Rows,
  references,
} from "eutaxy/cloudflare";

/** Two files are added, a third is refused as too large, and the first is read back. */
export default defineScenario({
  name: "object-stores",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // The stores before the object: its constructor reads the database, also while it is reset.
  setup: [
    d1Schema("DB", "./schema.sql"),
    r2Bucket("BUCKET"),
    durableObject("LIBRARY", { lib: {} }),
  ],
  drive: http(
    [
      { id: "add-a", path: "/files/a.txt", method: "POST", body: "alpha" },
      { id: "add-b", path: "/files/b.txt", method: "POST", body: "bravo, again" },
      { id: "add-c", path: "/files/c.txt", method: "POST", body: "charlie is too long" },
      { id: "read-a", path: "/files/a.txt", method: "GET" },
    ],
    { retries: 0 },
  ),
  externals: [],
  invariants: [
    references(
      "every-catalogue-row-has-its-bytes",
      d1Rows("DB", "catalogue"),
      "name",
      r2Rows("BUCKET"),
      "key",
    ),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
