import {
  defineScenario,
  durableObject,
  durableObjectTable,
  http,
  implies,
  objectCall,
  scriptedObject,
} from "eutaxy/cloudflare";

/** The scenario over one of the two objects: the planted one (`POOL`) or the fixed one (`SAFE_POOL`). */
export const machines = (binding: "POOL" | "SAFE_POOL") =>
  defineScenario({
    name: `object-machine-booted-off-record${binding === "SAFE_POOL" ? "-fixed" : ""}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      durableObject(binding, { pool: {} }),
      // The machines, scripted: every boot succeeds. The pool calls them through its own env.
      scriptedObject("MACHINE", { methods: { boot: { returns: { address: "10.0.0.7" } } } }),
    ],
    drive: http(
      [
        {
          id: "start-a",
          path: `/jobs/a${binding === "SAFE_POOL" ? "?fixed" : ""}`,
          method: "POST",
        },
      ],
      // The caller does not ask again: what the pool left behind is all there is.
      { retries: 0 },
    ),
    externals: [],
    invariants: [
      // The bug: a machine that booted and that no job on record names.
      implies(
        "a-booted-machine-is-on-record",
        objectCall("MACHINE", "boot"),
        "args.object",
        durableObjectTable(binding, "pool", "jobs"),
        "id",
      ),
    ],
    bounds: { maxFaultsPerRun: 1, maxRedeliveries: 1, maxConcurrentInvocations: 1, budgetMs: 4000 },
  });

export default machines("POOL");
