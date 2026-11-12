import {
  d1Rows,
  d1Schema,
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  http,
  r2Bucket,
  r2Rows,
  references,
} from "eutaxy/cloudflare";

/**
 * Three files sent to one object, which keeps the bytes in a bucket and
 * the catalogue in a database, both through its own env: every statement
 * and every bucket operation the object makes is an effect a fault can
 * land on. The third file is larger than the limit the object loaded
 * from the database when it was constructed.
 */
export const library = (concurrency: 1 | 2, faults: number) =>
  defineScenario({
    name: "v0-17-object-stores",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    // The stores before the object: its constructor reads the database, also while it is reset.
    setup: [
      d1Schema("DB", "./schema.sql"),
      r2Bucket("BUCKET"),
      durableObject("LIBRARY", { lib: {} }),
    ],
    drive: http(
      [
        { id: "file-1", path: "/files/a.txt", method: "POST", body: "alpha" },
        { id: "file-2", path: "/files/b.txt", method: "POST", body: "bravo, again" },
        { id: "file-3", path: "/files/c.txt", method: "POST", body: "charlie is too long" },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // A file the object recorded as listed is in the catalogue, whatever landed between the two writes.
      references(
        "every-listed-file-is-catalogued",
        {
          ...durableObjectTable("LIBRARY", "lib", "files"),
          where: [{ column: "status", op: "eq", value: "listed" }],
        },
        "name",
        d1Rows("DB", "catalogue"),
        "name",
      ),
      // The catalogue never names a file whose bytes are not there.
      references(
        "every-catalogue-row-has-its-bytes",
        d1Rows("DB", "catalogue"),
        "name",
        r2Rows("BUCKET"),
        "key",
      ),
      // The limit the constructor loaded holds: the oversized file is never stored.
      everyRow("nothing-over-the-limit", r2Rows("BUCKET"), [
        { column: "size", op: "lte", value: 16 },
      ]),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default library(2, 1);
