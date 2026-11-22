import { atMostOncePerKey, callee, defineScenario, http, serviceCall } from "eutaxy/cloudflare";

/** The same note with nothing given: the callee has no secret, the front Worker its config's region. */
export default defineScenario({
  name: "secret-of-a-callee-missing",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [callee("NOTES", { entry: "./notes/worker.ts", config: "./notes/wrangler.jsonc" })],
  drive: http([{ id: "n-1", path: "/notes/n-1", method: "POST" }], { retries: 0 }),
  externals: [],
  invariants: [
    atMostOncePerKey("each-note-handed-over-once", serviceCall("NOTES", "record"), "args.args.0"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
