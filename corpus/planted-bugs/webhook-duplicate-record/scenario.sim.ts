import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  http,
  httpResponse,
} from "eutaxy/cloudflare";

// The provider resends a webhook it got no 2xx for, up to three times.
const webhooks = http(
  [
    { path: "/webhooks/payments", body: { eventId: "evt-1", orderId: "o-1", amountCents: 1200 } },
    { path: "/webhooks/payments", body: { eventId: "evt-2", orderId: "o-2", amountCents: 500 } },
  ],
  { retries: 3 },
);

export default defineScenario({
  name: "webhook-duplicate-record",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: webhooks,
  invariants: [
    // The bug: a resend after a crash inserts the same event again.
    atMostOncePerKey("event-recorded-once", d1Write("DB"), d1Param(0)),
    // Holds: the resend recovers every event that was lost to a crash.
    atLeastOncePerMessage("every-event-recorded", webhooks, d1Write("DB"), d1Param(0), "eventId"),
    // Holds: the caller stops resending once it has a 2xx.
    atMostOncePerKey(
      "one-ok-response",
      httpResponse("/webhooks/payments", { ok: true }),
      "args.requestId",
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
