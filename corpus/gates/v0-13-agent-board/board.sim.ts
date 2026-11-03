import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  external,
  unique,
  websocket,
} from "eutaxy/cloudflare";

/** Two clients post three items between them; the digest the first item scheduled counts them all. */
export default defineScenario({
  name: "v0-13-agent-board",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("BOARD", { "b-1": {} })],
  drive: websocket([
    {
      id: "ann",
      path: "/agents/board/b-1",
      messages: [{ data: { id: "i-1", text: "first" } }, { data: { id: "i-2", text: "second" } }],
    },
    { id: "bob", path: "/agents/board/b-1", messages: [{ data: { id: "i-3", text: "third" } }] },
  ]),
  externals: [external("screening", "screening.example")],
  invariants: [
    unique("one-row-per-item", durableObjectTable("BOARD", "b-1", "items"), "id"),
    // The digest fires after the posts (its schedule is 30 s out, the posts are at once) and counts them all.
    everyRow("digest-counts-every-item", durableObjectTable("BOARD", "b-1", "digests"), [
      { column: "items", op: "eq", value: 3 },
    ]),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, maxConcurrentInvocations: 2, budgetMs: 2000 },
});
