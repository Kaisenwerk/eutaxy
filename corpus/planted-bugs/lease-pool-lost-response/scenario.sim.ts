import { defineScenario, durableObject, durableObjectRows, http, unique } from "eutaxy/cloudflare";

const free = (id: string) => ({ id, lease: null });

export default defineScenario({
  name: "lease-pool-lost-response",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // A pool of three free slots in the object named "pool".
  setup: [
    durableObject("POOL", {
      pool: { "slot:01": free("01"), "slot:02": free("02"), "slot:03": free("03") },
    }),
  ],
  // One project asks for a lease once; the caller does not resend.
  drive: http([{ path: "/projects/p-1/lease", method: "POST" }], { retries: 0 }),
  invariants: [
    // The bug: a lost answer and the Worker's retry leave the project holding two slots.
    unique("one-slot-per-project", durableObjectRows("POOL", "pool"), "value.lease.project"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
