import {
  defineScenario,
  durableObject,
  durableObjectTable,
  external,
  unique,
  websocket,
} from "eutaxy/cloudflare";

export default defineScenario({
  name: "agent-room-lost-update",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // The room r-1 starts empty; the SDK creates its own tables.
  setup: [durableObject("ROOM", { "r-1": {} })],
  // Two clients connect to the room and each sends one message; the two messages arrive at once.
  drive: websocket([
    { path: "/agents/room/r-1", messages: [{ data: { text: "hello from a" } }] },
    { path: "/agents/room/r-1", messages: [{ data: { text: "hello from b" } }] },
  ]),
  externals: [external("moderation", "moderation.example")],
  invariants: [
    // The bug: both messages read a count of 0 while the first awaits moderation, so both take the
    // count 1, in the Agent's own table as in what it broadcasts.
    unique("each-message-counted-once", durableObjectTable("ROOM", "r-1", "counts"), "n"),
  ],
  // No faults: the interleaving alone loses the update.
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
