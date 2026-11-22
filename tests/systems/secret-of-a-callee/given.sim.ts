import {
  atMostOncePerKey,
  callee,
  defineScenario,
  envVar,
  http,
  secret,
  serviceCall,
} from "eutaxy/cloudflare";

/** One note; the scenario gives the callee its secret and the front Worker its region. */
export default defineScenario({
  name: "secret-of-a-callee",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [
    callee("NOTES", { entry: "./notes/worker.ts", config: "./notes/wrangler.jsonc" }),
    // The callee's, under its qualified name; the front Worker's own, by its binding name.
    secret("notes/API_KEY", "test-key"),
    // Over the value the callee's own wrangler config gives.
    envVar("notes/TIER", "gold"),
    envVar("REGION", "eu"),
  ],
  drive: http([{ id: "n-1", path: "/notes/n-1", method: "POST" }], { retries: 0 }),
  externals: [],
  invariants: [
    atMostOncePerKey("each-note-handed-over-once", serviceCall("NOTES", "record"), "args.args.0"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
