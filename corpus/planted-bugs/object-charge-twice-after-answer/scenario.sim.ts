import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  http,
  service,
  serviceCall,
} from "eutaxy/cloudflare";

/** The scenario over one of the two objects: the planted one (`RUNNER`) or the fixed one (`SAFE_RUNNER`). */
export const billing = (binding: "RUNNER" | "SAFE_RUNNER") =>
  defineScenario({
    name: `object-charge-twice-after-answer${binding === "SAFE_RUNNER" ? "-fixed" : ""}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      durableObject(binding, { r: {} }),
      // The billing Worker, scripted: every charge succeeds. The object calls it through its own env.
      service("BILLING", { methods: { charge: { returns: { chargeId: "ch-1" } } } }),
    ],
    drive: http(
      [
        {
          id: "run-1",
          path: `/runs/run-1${binding === "SAFE_RUNNER" ? "?fixed" : ""}`,
          method: "POST",
        },
      ],
      { retries: 0 },
    ),
    externals: [],
    invariants: [
      // The bug: a charge the object did not get to record is made again by the watchdog.
      atMostOncePerKey("charged-once", serviceCall("BILLING", "charge"), "args.args.0"),
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 1, maxConcurrentInvocations: 1, budgetMs: 4000 },
  });

export default billing("RUNNER");
