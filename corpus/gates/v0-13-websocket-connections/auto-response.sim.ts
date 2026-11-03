import {
  defineScenario,
  durableObject,
  durableObjectRows,
  everyRow,
  websocket,
} from "eutaxy/cloudflare";

/** A room on the runtime's WebSocket auto-response: a feature Eutaxy does not model, so it refuses the run. */
export default defineScenario({
  name: "v0-13-auto-response",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("PING_ROOM", { lobby: {} })],
  drive: websocket([
    { id: "ann", path: "/ping-rooms/lobby?name=ann", messages: [{ data: "ping" }] },
  ]),
  invariants: [
    everyRow("none", durableObjectRows("PING_ROOM", "lobby"), [{ column: "key", op: "notNull" }]),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 1000 },
});
