import {
  atLeastOncePerMessage,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  http,
} from "eutaxy/cloudflare";

// The platform resends an event it got no 2xx for four times: after 15 s, 5 min, 1 h and 6 h.
export const resendSchedule = [15_000, 300_000, 3_600_000, 21_600_000];

export const events = http(
  [{ path: "/webhooks/chat", body: { eventId: "evt-1", subscription: "sub-1" } }],
  { retries: 4, delaysMs: resendSchedule },
);

export default defineScenario({
  name: "webhook-lease-outlives-retries",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: events,
  invariants: [
    // The bug: a crash leaves the lease held for longer than every resend, so the event is lost.
    atLeastOncePerMessage("every-event-applied", events, d1Write("DB"), d1Param(0), "eventId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 4, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
