import {
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  implies,
  queue,
  queueAck,
} from "eutaxy/cloudflare";

const postings = queue("postings", [
  { body: { postingId: "p-1", account: "alice", delta: 100 } },
  { body: { postingId: "p-2", account: "bob", delta: 40 } },
  { body: { postingId: "p-3", account: "alice", delta: -30 } },
]);

export default defineScenario({
  name: "d1-ledger",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: postings,
  invariants: [
    everyRow("balances-non-negative", d1Rows("DB", "accounts"), [
      { column: "balance", op: "gte", value: 0 },
    ]),
    implies(
      "acked-posting-recorded",
      queueAck("postings"),
      "args.body.postingId",
      d1Rows("DB", "postings"),
      "posting_id",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 3, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
