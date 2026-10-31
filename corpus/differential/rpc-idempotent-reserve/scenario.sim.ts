import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  rpc,
} from "eutaxy/cloudflare";

// A calling Worker that resends a call it got an error or no answer for, up to two times.
const calls = rpc(
  [
    { method: "reserve", args: ["o-1", 2] },
    { method: "reserve", args: ["o-2", 1] },
    { method: "reserve", args: ["o-3", 0] },
    { method: "reservation", args: ["o-1"] },
    { method: "reservation", args: ["o-9"] },
  ],
  { retries: 2 },
);

export default defineScenario({
  name: "rpc-idempotent-reserve",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: calls,
  invariants: [
    atMostOncePerKey("reserved-once", d1Write("DB"), d1Param(0)),
    atLeastOncePerMessage(
      "every-order-reserved",
      rpc(calls.calls.slice(0, 2), { retries: 2 }),
      d1Write("DB"),
      d1Param(0),
      "0",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
