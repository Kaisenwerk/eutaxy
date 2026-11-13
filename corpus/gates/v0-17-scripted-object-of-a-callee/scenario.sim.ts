import {
  callee,
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  http,
  implies,
  objectCall,
  scriptedObject,
} from "eutaxy/cloudflare";

const jobs = durableObjectTable("jobs/POOL", "pool", "jobs");

/**
 * Two jobs started through both Workers' real code. The jobs Worker's pool
 * object runs each on a machine, an object of a namespace of the jobs
 * Worker's that the scenario scripts under the Worker's name. `sure` is
 * for a run with no faults: every job then ends running, which it could
 * not if a machine were asked for real.
 */
export const started = (concurrency: 1 | 2, faults: number, sure = false) =>
  defineScenario({
    name: `v0-17-scripted-object-of-a-callee${sure ? "" : "-faulted"}`,
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      callee("JOBS", { entry: "./jobs/worker.ts", config: "./jobs/wrangler.jsonc" }),
      durableObject("jobs/POOL", { pool: {} }),
      scriptedObject("jobs/MACHINE", { methods: { boot: { returns: { address: "10.0.0.7" } } } }),
    ],
    drive: http(
      [
        { id: "start-a", path: "/jobs/a", method: "POST" },
        { id: "start-b", path: "/jobs/b", method: "POST" },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // A machine that was booted is a job the pool has on record.
      implies(
        "a-booted-machine-is-on-record",
        objectCall("jobs/MACHINE", "boot"),
        "args.object",
        jobs,
        "id",
      ),
      // A job recorded as running carries the address its machine answered with.
      everyRow(
        "a-running-job-has-its-machine",
        { ...jobs, where: [{ column: "state", op: "eq", value: "running" }] },
        [{ column: "address", op: "eq", value: "10.0.0.7" }],
      ),
      ...(sure
        ? [everyRow("every-job-runs", jobs, [{ column: "state", op: "eq", value: "running" }])]
        : []),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default started(2, 0, true);
