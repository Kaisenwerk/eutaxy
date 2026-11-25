import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  http,
} from "@eutaxy/cloudflare";

/** Two transfers, one at a time; each posts to both accounts at once, and each account reports its entry after answering. */
export default defineScenario({
  name: "parallel-object-calls",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("ACCOUNT", { from: {}, to: {} })],
  drive: http(
    [
      { id: "t-1", path: "/transfers/t-1", method: "POST" },
      { id: "t-2", path: "/transfers/t-2", method: "POST" },
    ],
    { retries: 0 },
  ),
  externals: [external("audit", "audit.example", { responses: [{ status: 200, body: {} }] })],
  invariants: [
    everyRow("every-debit-is-five", durableObjectTable("ACCOUNT", "from", "entries"), [
      { column: "amount", op: "eq", value: -5 },
    ]),
    everyRow("every-credit-is-five", durableObjectTable("ACCOUNT", "to", "entries"), [
      { column: "amount", op: "eq", value: 5 },
    ]),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
