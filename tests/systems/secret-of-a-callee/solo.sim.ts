import {
  atMostOncePerKey,
  defineScenario,
  durableObject,
  envVar,
  http,
  objectCall,
  secret,
} from "eutaxy/cloudflare";

/** A Worker with no callee and no service binding: its var and its secret come from the scenario alone. */
export default defineScenario({
  name: "secret-of-a-worker",
  worker: { entry: "./solo/worker.ts", config: "./solo/wrangler.jsonc" },
  setup: [durableObject("KEEPER"), envVar("REGION", "eu"), secret("API_KEY", "test-key")],
  drive: http([{ id: "k-1", path: "/keep/k-1", method: "POST" }], { retries: 0 }),
  externals: [],
  invariants: [atMostOncePerKey("each-kept-once", objectCall("KEEPER", "tell"), "args.args.0")],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
