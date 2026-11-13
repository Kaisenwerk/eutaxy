import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  http,
  implies,
  objectCall,
  scriptedObject,
} from "eutaxy/cloudflare";

const jobs = durableObjectTable("POOL", "pool", "jobs");

/**
 * Two jobs started, a machine asked by the Worker itself, and the second
 * job stopped. The machines' namespace is scripted: every call on a
 * machine, from the pool inside a call, from the pool's work after its
 * answer, from its alarm and from the Worker, is an effect a fault can
 * land on, answered from the script.
 */
export const pool = (concurrency: 1 | 2, faults: number) =>
  defineScenario({
    name: "v0-17-scripted-object",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [
      durableObject("POOL", { pool: {} }),
      scriptedObject("MACHINE", {
        methods: {
          boot: { returns: { address: "10.0.0.7" } },
          snapshot: { throws: "Error: snapshots are not enabled" },
          halt: { returns: { halted: true } },
          status: { returns: { up: true } },
        },
        fetch: [{ method: "POST", path: "/warm", status: 200, body: { warm: true } }],
      }),
    ],
    drive: http(
      [
        { id: "start-a", path: "/jobs/a", method: "POST" },
        { id: "start-b", path: "/jobs/b", method: "POST" },
        { id: "ask-a", path: "/machines/a", method: "GET" },
        { id: "stop-b", path: "/jobs/b", method: "DELETE" },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // A machine that was booted is a job the pool has on record: none runs unknown to it.
      implies(
        "a-booted-machine-is-on-record",
        objectCall("MACHINE", "boot"),
        "args.object",
        jobs,
        "id",
      ),
      // A machine is halted only for a job the pool knows.
      implies(
        "a-halted-machine-was-a-job's",
        objectCall("MACHINE", "halt"),
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
      // Only a job that got its machine is ever marked warm.
      everyRow(
        "a-warm-job-was-booted",
        { ...jobs, where: [{ column: "warmed", op: "eq", value: 1 }] },
        [{ column: "address", op: "notNull" }],
      ),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

export default pool(2, 1);
