import {
  defineScenario,
  durableObject,
  durableObjectRows,
  everyRow,
  websocket,
} from "eutaxy/cloudflare";

/** The room closes a connection before answering its upgrade; the client's message has nowhere to go. */
export default defineScenario({
  name: "v0-13-turned-away",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("ROOM", { lobby: {} })],
  drive: websocket([
    { id: "nobody", path: "/rooms/lobby?name=nobody", messages: [{ data: "hi" }] },
  ]),
  invariants: [
    everyRow(
      "turned-away-cleanly",
      durableObjectRows("ROOM", "lobby", [{ column: "key", op: "eq", value: "close-1" }]),
      [{ column: "value", op: "eq", value: 4001 }],
    ),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 1000 },
});
