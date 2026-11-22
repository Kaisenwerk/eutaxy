import { atMostOncePerKey, callee, defineScenario, http, serviceCall } from "eutaxy/cloudflare";

/** Two notes, one with text and one without: the second is refused by the notes Worker. */
export default defineScenario({
  name: "console-output",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [callee("NOTES", { entry: "./notes/worker.ts", config: "./notes/wrangler.jsonc" })],
  drive: http(
    [
      { id: "n-1", path: "/notes/n-1", method: "POST", body: "milk" },
      { id: "n-2", path: "/notes/n-2", method: "POST", body: "" },
    ],
    { retries: 0 },
  ),
  externals: [],
  invariants: [
    atMostOncePerKey("each-note-handed-over-once", serviceCall("NOTES", "record"), "args.args.0"),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
