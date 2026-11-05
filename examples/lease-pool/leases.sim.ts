import {
  defineScenario,
  durableObject,
  durableObjectTable,
  everyRow,
  http,
  unique,
} from "eutaxy/cloudflare";

// The pool's tables, as a deployment would create them in a migration, with three free runners.
const pool = {
  schema: `
    CREATE TABLE slots (id TEXT PRIMARY KEY, project TEXT, token TEXT, expires_at INTEGER);
    CREATE TABLE grants (token TEXT NOT NULL, project TEXT NOT NULL, slot TEXT NOT NULL,
                         granted_at INTEGER NOT NULL, ended_at INTEGER);`,
  rows: { slots: [{ id: "r-1" }, { id: "r-2" }, { id: "r-3" }] },
};
const grants = durableObjectTable("POOL", "pool", "grants");

export default defineScenario({
  name: "leases",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  // The alarm wakes once per expiry; three requests at most (two, and a retry) need three wake-ups,
  // and the cap leaves room for more (a capped alarm would leave a grant open by the bound, not a bug).
  setup: [durableObject("POOL", {}, { sql: { pool }, alarmsPerObject: 6 })],
  // Two projects ask for a runner; the caller does not resend (the Worker retries the pool itself).
  drive: http(
    [
      { path: "/projects/p-1/lease", method: "POST" },
      { path: "/projects/p-2/lease", method: "POST" },
    ],
    { retries: 0 },
  ),
  invariants: [
    // One request, one runner: no token is granted twice.
    unique("one-runner-per-request", grants, "token"),
    // The alarm takes every lease back once it expires, so every grant is closed by the end.
    everyRow("every-lease-ends", grants, [{ column: "ended_at", op: "notNull" }]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
