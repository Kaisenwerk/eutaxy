/** Runs inside workerd: the proxied run and the raw run must agree on attempts and final state. */

import { env } from "cloudflare:workers";
import {
  check,
  createCloudflarePlatform,
  d1Rows,
  d1Schema,
  defineScenario,
  everyRow,
  expectHolds,
  queue,
  runDifferential,
} from "eutaxy/cloudflare";
import { expect, test } from "vitest";
import scenario from "./scenario.sim.ts";
import schema from "./schema.sql?raw";
import handler from "./worker.ts";

test("proxies agree with the raw bindings", async () => {
  const result = await runDifferential(scenario, { env, handler, schemas: { DB: schema } });
  expect(result.differences, result.differences.join("\n")).toEqual([]);
  expect(result.equal).toBe(true);
  expect(result.eutaxy.attempts).toHaveLength(3);
  expect(result.eutaxy.state["DB"]?.["postings"]).toHaveLength(3);
});

test("the end-of-run snapshot feeds state invariants", async () => {
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  // Fault-free: the ledger is correct by construction, so both state invariants hold.
  const verdict = await check(scenario, platform, {
    seed: "fault-free",
    maxRuns: 1,
    faultProbability: 0,
    budgetMs: 30_000,
  });
  expect(verdict.kind).toBe("BOUNDED");
  const snapshot = verdict.kind === "BOUNDED" ? null : verdict;
  expect(snapshot).toBeNull();
});

test("balances stay non-negative and every ack has its posting under faults too", async () => {
  // The ledger is idempotent on posting_id, so crashes and redeliveries cannot break either invariant.
  const platform = createCloudflarePlatform({ env, handler, schemas: { DB: schema } });
  await expectHolds(scenario, platform, { seed: "faults", maxRuns: 40 });
});

test("the reset before each run clears tables that reference each other", async () => {
  // Rows in a parent, a child and a grandchild: from the second run on, the reset drops tables that hold
  // rows other tables reference, which SQLite's foreign key checks refuse in the wrong order.
  const fkSchema = `
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id));
    CREATE TABLE runs (id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id));
    CREATE TABLE owners (id TEXT PRIMARY KEY, pet TEXT REFERENCES pets(id));
    CREATE TABLE pets (id TEXT PRIMARY KEY, owner TEXT REFERENCES owners(id));
    CREATE TABLE audit (what TEXT NOT NULL);
    CREATE TRIGGER owners_gone AFTER DELETE ON owners BEGIN INSERT INTO audit (what) VALUES (old.id); END;`;
  const scenario = defineScenario({
    name: "d1-reset-foreign-keys",
    worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
    setup: [d1Schema("DB", "./schema.sql")],
    drive: queue("postings", [{ body: {} }]),
    invariants: [
      everyRow("every-run-has-a-session", d1Rows("DB", "runs"), [
        { column: "session", op: "notNull" },
      ]),
    ],
    bounds: {
      maxFaultsPerRun: 0,
      maxRedeliveries: 0,
      maxConcurrentInvocations: 1,
      budgetMs: 30_000,
    },
  });
  const platform = createCloudflarePlatform({
    env,
    handler: {
      async queue(batch, e: { DB: D1Database }) {
        await e.DB.prepare("INSERT INTO projects (id) VALUES ('p-1')").run();
        await e.DB.prepare("INSERT INTO sessions (id, project) VALUES ('s-1', 'p-1')").run();
        await e.DB.prepare("INSERT INTO runs (id, session) VALUES ('r-1', 's-1')").run();
        // Two tables that reference each other: a cycle no drop order clears.
        await e.DB.prepare("INSERT INTO owners (id) VALUES ('o-1')").run();
        await e.DB.prepare("INSERT INTO pets (id, owner) VALUES ('d-1', 'o-1')").run();
        await e.DB.prepare("UPDATE owners SET pet = 'd-1' WHERE id = 'o-1'").run();
        for (const m of batch.messages) m.ack();
      },
    } satisfies ExportedHandler<{ DB: D1Database }>,
    schemas: { DB: fkSchema },
  });
  const verdict = await check(scenario, platform, { seed: "fk", maxRuns: 3, faultProbability: 0 });
  expect(verdict.kind, JSON.stringify(verdict).slice(0, 400)).toBe("BOUNDED");
});
