import {
  defineScenario,
  durableObject,
  durableObjectRows,
  everyRow,
  websocket,
} from "@eutaxy/cloudflare";

/** One client in a room whose close handler finishes only some real time after the connection was closed. */
export default defineScenario({
  name: "slow-close",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("SLOW_ROOM", { lobby: {} })],
  drive: websocket([
    { id: "ann", path: "/slow-rooms/lobby?name=ann", messages: [{ data: "one" }] },
  ]),
  invariants: [
    // The connection is open when the run is over, so the room counts its close after the
    // snapshot: a count in a snapshot is the close of the run before.
    everyRow(
      "no-close-of-another-run",
      durableObjectRows("SLOW_ROOM", "lobby", [{ column: "key", op: "eq", value: "closes" }]),
      [{ column: "value", op: "eq", value: 0 }],
    ),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 1, budgetMs: 1000 },
});
