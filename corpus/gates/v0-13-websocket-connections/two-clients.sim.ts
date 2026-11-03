import {
  defineScenario,
  durableObject,
  durableObjectRows,
  everyRow,
  websocket,
} from "eutaxy/cloudflare";

/** Two clients in one room, three messages between them; faults on the sends drop the instance mid-way. */
export default defineScenario({
  name: "v0-13-two-clients",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("ROOM", { lobby: {} })],
  drive: websocket([
    { id: "ann", path: "/rooms/lobby?name=ann", messages: [{ data: "one" }, { data: "two" }] },
    { id: "bob", path: "/rooms/lobby?name=bob", messages: [{ data: "three" }] },
  ]),
  invariants: [
    // Every close the room saw was a normal one (1000: the object's, or the end of the run's) or the
    // Worker dying as it held the connection (1011); never anything else.
    everyRow(
      "every-close-is-clean",
      durableObjectRows("ROOM", "lobby", [
        { column: "key", op: "in", value: ["close-1", "close-2"] },
      ]),
      [{ column: "value", op: "in", value: [1000, 1011] }],
    ),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
