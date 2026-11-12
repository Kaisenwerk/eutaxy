import {
  defineScenario,
  durableObject,
  durableObjectTable,
  http,
  references,
  unique,
  workflow,
  workflowRows,
} from "eutaxy/cloudflare";

const setup = [
  workflow("RUNS", "RunJob", { name: "run-job" }),
  durableObject("JOBS", { book: {} }),
];

/**
 * Two jobs submitted to one object, which starts a Workflow instance for
 * each through its own env, and a look at the first job's run: every
 * call the object makes on the binding, and on the instance it gives, is
 * an effect a fault can land on, and the instances run the scenario's
 * class in the model.
 */
export const jobs = (concurrency: 1 | 2, faults: number) =>
  defineScenario({
    name: "v0-17-object-bindings",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup,
    drive: http(
      [
        { id: "job-1", path: "/jobs/a", method: "POST" },
        { id: "job-2", path: "/jobs/b", method: "POST" },
        { id: "look-1", path: "/jobs/a", method: "GET" },
      ],
      { retries: 1 },
    ),
    externals: [],
    invariants: [
      // A job the book recorded as started or done has its run, whatever landed around the create.
      references(
        "every-started-job-has-its-run",
        {
          ...durableObjectTable("JOBS", "book", "jobs"),
          where: [{ column: "status", op: "neq", value: "accepted" }],
        },
        "run_id",
        workflowRows("RUNS"),
        "id",
      ),
      // A run that finished has finished its job.
      references(
        "every-finished-run-finished-its-job",
        workflowRows("RUNS", [{ column: "status", op: "eq", value: "complete" }]),
        "id",
        {
          ...durableObjectTable("JOBS", "book", "jobs"),
          where: [{ column: "status", op: "eq", value: "done" }],
        },
        "run_id",
      ),
      // A job submitted twice has one run.
      unique("one-run-a-job", workflowRows("RUNS"), "params.id"),
    ],
    bounds: {
      maxFaultsPerRun: faults,
      maxRedeliveries: 1,
      maxConcurrentInvocations: concurrency,
      budgetMs: 4000,
    },
  });

/** The object reads a binding of a kind the simulation does not model. */
export const cached = defineScenario({
  name: "v0-17-object-bindings-unmodelled",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup,
  drive: http([{ id: "peek-1", path: "/cached/a", method: "GET" }], { retries: 0 }),
  externals: [],
  invariants: [unique("one-run-a-job", workflowRows("RUNS"), "params.id")],
  bounds: {
    maxFaultsPerRun: 0,
    maxRedeliveries: 0,
    maxConcurrentInvocations: 1,
    budgetMs: 2000,
  },
});

export default jobs(2, 1);
