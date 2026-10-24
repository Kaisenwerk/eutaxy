import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  external,
  fetchCall,
  http,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "alarm-reminder-sent-twice",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("REMINDERS", { reminders: {} })],
  // One reminder, due in a minute of virtual time.
  drive: http([{ path: "/reminders", body: { id: "rem-1", inMs: 60_000 } }], { retries: 0 }),
  externals: [
    // The mail API deduplicates by Idempotency-Key; the planted object never sends one.
    external("mail", "mail.example", {
      dedupeBy: "Idempotency-Key",
      responses: [{ method: "POST", path: "/send", status: 202, body: { queued: true } }],
    }),
  ],
  invariants: [
    // The bug: a retried alarm sends the same reminder again.
    atMostOncePerKey("reminder-sent-once", fetchCall("mail", "POST"), "args.body.reminderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 6, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
