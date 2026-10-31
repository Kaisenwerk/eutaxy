import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  rpc,
  rpcResponse,
} from "eutaxy/cloudflare";

// The calling Worker resends a reserve() call it got an error or no answer for, up to two times.
const calls = rpc(
  [
    { method: "reserve", args: ["o-1", 2] },
    { method: "reserve", args: ["o-2", 1] },
  ],
  { retries: 2 },
);

export default defineScenario({
  name: "rpc-reserve-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: calls,
  invariants: [
    // The bug: a resend after a crash inserts the same order again.
    atMostOncePerKey("reserved-once", d1Write("DB"), d1Param(0)),
    // Holds: the resend recovers every order that was lost to a crash.
    atLeastOncePerMessage("every-order-reserved", calls, d1Write("DB"), d1Param(0), "0"),
    // Holds: the caller stops resending once it has an answer.
    atMostOncePerKey("one-answer", rpcResponse("reserve", { ok: true }), "args.callId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
