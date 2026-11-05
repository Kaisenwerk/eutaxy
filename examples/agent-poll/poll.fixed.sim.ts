import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  websocket,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "poll-fixed",
  worker: { entry: "./worker.fixed.ts", config: "./wrangler.jsonc" },
  // The poll p-1 starts empty; the SDK creates its own tables.
  setup: [durableObject("POLL", { "p-1": {} })],
  // Two voters connect through the SDK's router and vote at once.
  drive: websocket([
    { id: "ann", path: "/agents/poll/p-1", messages: [{ data: { voter: "ann" } }] },
    { id: "bob", path: "/agents/poll/p-1", messages: [{ data: { voter: "bob" } }] },
  ]),
  // The membership API answers 200 for every voter.
  externals: [external("members", "members.example")],
  invariants: [
    // The schedule closes the poll a minute after the first vote: its result counts both votes.
    everyRow("result-counts-every-vote", durableObjectTable("POLL", "p-1", "results"), [
      { column: "votes", op: "eq", value: 2 },
    ]),
  ],
  // No faults: two votes in flight at once are enough.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
