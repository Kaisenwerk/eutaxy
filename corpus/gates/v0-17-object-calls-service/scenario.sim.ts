import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  http,
  service,
  serviceCall,
} from "eutaxy/cloudflare";

/**
 * A quote and two runs on one object, which calls the model and billing
 * Workers through its own service bindings: scripted here, so every call
 * the object makes is an effect a fault can land on.
 */
export const jobs = (concurrency: 1 | 2, faults: number) =>
  defineScenario({
    name: "v0-17-object-calls-service",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      durableObject("JOBS", { j: {} }),
      service("MODEL", {
        methods: { estimate: { returns: { steps: 3 } }, plan: { returns: { steps: 2 } } },
      }),
      service("BILLING", { methods: { charge: { returns: { chargeId: "ch-1" } } } }),
    ],
    drive: http(
      [
        { id: "quote-1", path: "/quote/run-1", method: "POST" },
        { id: "run-1", path: "/runs/run-1", method: "POST" },
        { id: "run-2", path: "/runs/run-2", method: "POST" },
      ],
      { retries: 0 },
    ),
    externals: [],
    invariants: [
      // No run is billed twice, whatever lands on the object's calls and whenever the watchdog fires.
      atMostOncePerKey("charged-once", serviceCall("BILLING", "charge"), "args.args.0"),
      // A run recorded as charged carries the charge and the plan it was billed for.
      everyRow(
        "a-charged-run-has-its-charge",
        {
          ...durableObjectTable("JOBS", "j", "runs"),
          where: [{ column: "status", op: "eq", value: "charged" }],
        },
        [
          { column: "charge_id", op: "eq", value: "ch-1" },
          { column: "steps", op: "eq", value: 2 },
        ],
      ),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default jobs(2, 1);
