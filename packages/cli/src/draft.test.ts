import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { agentSegment, draftScenario, migrationOrder, renderDraft, runDraft } from "./draft.ts";

const root = mkdtempSync(join(tmpdir(), "eutaxy-draft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A project directory with these files, JSON values written as JSON. */
function project(name: string, files: Record<string, unknown>): string {
  const dir = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(
      join(dir, path),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

const worker = "export default { async fetch() { return new Response('ok'); } };\n";

describe("draftScenario", () => {
  test("bindings become setup steps; what the simulation does not model becomes a note", () => {
    const dir = project("bindings", {
      "wrangler.jsonc": `{
        // a comment, as wrangler.jsonc allows
        "name": "shop",
        "main": "src/index.ts",
        "d1_databases": [{ "binding": "DB", "database_name": "shop", "database_id": "x" }],
        "r2_buckets": [{ "binding": "FILES", "bucket_name": "files" }],
        "durable_objects": { "bindings": [
          { "name": "CART", "class_name": "Cart" },
          { "name": "STOCK", "class_name": "Stock", "script_name": "inventory" }
        ] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Cart"] }],
        "workflows": [{ "name": "ship", "binding": "SHIP", "class_name": "Shipping" }],
        "kv_namespaces": [{ "binding": "CACHE", "id": "x" }],
        "queues": { "producers": [{ "binding": "EVENTS", "queue": "events" }] },
      }`,
      "src/index.ts": worker,
      "shop.sql": "CREATE TABLE t (id TEXT);",
    });
    const d = draftScenario({ config: join(dir, "wrangler.jsonc") });
    expect(d.name).toBe("shop");
    expect(d.worker).toEqual({ entry: "./src/index.ts", config: "./wrangler.jsonc" });
    expect(d.setup).toEqual([
      { kind: "d1", binding: "DB", schemaFile: "./shop.sql" },
      { kind: "durable_object", binding: "CART", sqlite: true },
      { kind: "r2", binding: "FILES" },
      { kind: "workflow", binding: "SHIP", className: "Shipping", name: "ship" },
    ]);
    expect(d.drive).toEqual({ kind: "http" });
    expect(d.notes).toEqual([
      "Durable Object STOCK is inventory's class Stock: name inventory with callee() to run it",
      "not modelled: KV namespace CACHE; a run that touches it is UNSUPPORTED",
      "not modelled: Queue producer EVENTS; a run that sends to it is UNSUPPORTED",
    ]);
  });

  test("a D1 binding without a schema file names one to write, or takes its migrations in order", () => {
    const bare = project("no-schema", {
      "wrangler.json": { name: "a", main: "w.ts", d1_databases: [{ binding: "DB" }] },
      "w.ts": worker,
      "one.sql": "",
      "two.sql": "",
    });
    const d = draftScenario({ config: join(bare, "wrangler.json") });
    expect(d.setup).toEqual([{ kind: "d1", binding: "DB", schemaFile: "./schema.sql" }]);
    expect(d.notes[0]).toContain("no schema file found");
    // Migrations instead of a schema: one step per migration, in order, as plain files or one folder each.
    const migrated = project("migrations", {
      "wrangler.json": { name: "a", main: "w.ts", d1_databases: [{ binding: "DB" }] },
      "w.ts": worker,
      "migrations/0002_more.sql": "ALTER TABLE t ADD y TEXT;",
      "migrations/0001_init.sql": "CREATE TABLE t (id TEXT);",
      "migrations/README.md": "not a migration",
    });
    const m = draftScenario({ config: join(migrated, "wrangler.json") });
    expect(m.setup).toEqual([
      { kind: "d1", binding: "DB", schemaFile: "./migrations/0001_init.sql" },
      { kind: "d1", binding: "DB", schemaFile: "./migrations/0002_more.sql" },
    ]);
    expect(m.notes).toEqual([]);
    const drizzle = project("drizzle", {
      "wrangler.json": {
        name: "a",
        main: "w.ts",
        d1_databases: [{ binding: "DB", migrations_dir: "drizzle" }],
      },
      "w.ts": worker,
      "drizzle/20260101_init/migration.sql": "CREATE TABLE t (id TEXT);",
      "drizzle/20260202_more/migration.sql": "ALTER TABLE t ADD y TEXT;",
    });
    expect(draftScenario({ config: join(drizzle, "wrangler.json") }).setup).toEqual([
      { kind: "d1", binding: "DB", schemaFile: "./drizzle/20260101_init/migration.sql" },
      { kind: "d1", binding: "DB", schemaFile: "./drizzle/20260202_more/migration.sql" },
    ]);
  });

  test("the drive: a queue consumer, else a Cron Trigger, else an Agent's route, else fetch()", () => {
    const queued = project("queued", {
      "wrangler.json": {
        name: "q",
        main: "w.ts",
        queues: { consumers: [{ queue: "jobs" }, { queue: "other" }] },
        triggers: { crons: ["0 * * * *"] },
      },
      "w.ts": worker,
    });
    const q = draftScenario({ config: join(queued, "wrangler.json") });
    expect(q.drive).toEqual({ kind: "queue", queue: "jobs" });
    expect(q.notes).toEqual([
      "the Worker consumes 2 queues; one drive per scenario, so a scenario per queue",
      "the Worker also has Cron Triggers (0 * * * *); a scenario per drive",
    ]);
    const cron = project("cron", {
      "wrangler.json": { name: "c", main: "w.ts", triggers: { crons: ["*/5 * * * *"] } },
      "w.ts": worker,
    });
    expect(draftScenario({ config: join(cron, "wrangler.json") }).drive).toEqual({
      kind: "cron",
      cron: "*/5 * * * *",
    });
    const agent = project("agent", {
      "wrangler.json": {
        name: "g",
        main: "w.ts",
        durable_objects: { bindings: [{ name: "ChatRoom", class_name: "ChatRoom" }] },
      },
      "w.ts": `import { routeAgentRequest } from "agents";\nexport default { fetch: (r, e) => routeAgentRequest(r, e) };\n`,
    });
    expect(draftScenario({ config: join(agent, "wrangler.json") }).drive).toEqual({
      kind: "websocket",
      agent: "chat-room",
    });
  });

  test("externals: the hosts fetched by a literal URL, in the module and the modules it imports", () => {
    const dir = project("externals", {
      "wrangler.json": { name: "x", main: "src/w.ts" },
      "src/w.ts": `import { mail } from "./mail.js";\nimport "./setup.ts";\nexport default { async fetch() { await fetch("https://api.payments.example/charge"); await mail(); const { audit } = await import("./audit.ts"); await audit(); return new Response(); } };\n`,
      "src/setup.ts": 'await fetch("https://config.example:8443/flags");\n',
      "src/audit.ts": 'export const audit = () => fetch("https://audit.example:443/log");\n',
      // A URL in a template literal: its host is still literal.
      "src/mail.ts": "export const mail = (to) => fetch(`https://mail.example/send/` + to);\n",
    });
    expect(draftScenario({ config: join(dir, "wrangler.json") }).externals).toEqual([
      { name: "api", host: "api.payments.example" },
      // The modules in import order; a non-default port is part of the host, as URL.host has it.
      { name: "mail", host: "mail.example" },
      { name: "config", host: "config.example:8443" },
      { name: "audit", host: "audit.example" },
    ]);
  });

  test("a service binding runs the Worker whose config is found under the directory, else it is scripted", () => {
    const dir = project("services", {
      "wrangler.json": {
        name: "front",
        main: "w.ts",
        services: [
          { binding: "BILLING", service: "billing" },
          { binding: "MAIL", service: "mailer" },
        ],
      },
      "w.ts": worker,
      "workers/billing/wrangler.json": {
        name: "billing",
        main: "src/index.ts",
        d1_databases: [{ binding: "DB", database_name: "billing" }],
      },
      "workers/billing/src/index.ts": worker,
      "workers/billing/schema.sql": "",
    });
    const d = draftScenario({ config: join(dir, "wrangler.json") });
    expect(d.setup).toEqual([
      {
        kind: "callee",
        binding: "BILLING",
        entry: "./workers/billing/src/index.ts",
        config: "./workers/billing/wrangler.json",
      },
      { kind: "d1", binding: "billing/DB", schemaFile: "./workers/billing/schema.sql" },
      { kind: "service", binding: "MAIL" },
    ]);
    expect(d.notes[0]).toContain("service binding MAIL: no wrangler config named mailer");
  });

  test("paths are relative to where the scenario will live, which must hold the Worker's files", () => {
    const dir = project("elsewhere", {
      "deploy/wrangler.json": { name: "e", main: "../w.ts", d1_databases: [{ binding: "DB" }] },
      "deploy/schema.sql": "",
      "w.ts": worker,
    });
    const d = draftScenario({ config: join(dir, "deploy", "wrangler.json"), scenarioDir: dir });
    expect(d.worker).toEqual({ entry: "./w.ts", config: "./deploy/wrangler.json" });
    expect(d.setup).toEqual([{ kind: "d1", binding: "DB", schemaFile: "./deploy/schema.sql" }]);
    // Below the Worker's module, eutaxy check could not find it: refused, naming what is out of reach.
    expect(() =>
      draftScenario({
        config: join(dir, "deploy", "wrangler.json"),
        scenarioDir: join(dir, "sim"),
      }),
    ).toThrow("eutaxy check finds the Worker's module and its schema files beneath");
  });

  test("a callee's resources are set up under its name, except the ones it shares with the caller", () => {
    const dir = project("callee-resources", {
      "wrangler.json": {
        name: "front",
        main: "w.ts",
        d1_databases: [{ binding: "DB", database_name: "main", database_id: "db-1" }],
        r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
        services: [{ binding: "BACK", service: "back" }],
        durable_objects: { bindings: [{ name: "LOCKS", class_name: "Lock", script_name: "back" }] },
      },
      "w.ts": worker,
      "schema.sql": "",
      "back/wrangler.json": {
        name: "back",
        main: "w.ts",
        d1_databases: [{ binding: "DB", database_name: "main", database_id: "db-1" }],
        r2_buckets: [
          { binding: "FILES", bucket_name: "files" },
          { binding: "ARCHIVE", bucket_name: "archive" },
        ],
        durable_objects: {
          bindings: [
            { name: "LOCK", class_name: "Lock" },
            { name: "SESSIONS", class_name: "Session" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Lock", "Session"] }],
        workflows: [{ name: "cleanup", binding: "CLEANUP", class_name: "Cleanup" }],
      },
      "back/w.ts": `import { routeAgentRequest } from "agents";\nexport default { fetch: (r, e) => routeAgentRequest(r, e) };\n`,
    });
    const d = draftScenario({ config: join(dir, "wrangler.json") });
    expect(d.setup).toEqual([
      { kind: "d1", binding: "DB", schemaFile: "./schema.sql" },
      { kind: "durable_object", binding: "LOCKS", sqlite: true },
      { kind: "r2", binding: "FILES" },
      { kind: "callee", binding: "BACK", entry: "./back/w.ts", config: "./back/wrangler.json" },
      { kind: "durable_object", binding: "back/SESSIONS", sqlite: true },
      { kind: "r2", binding: "back/ARCHIVE" },
      { kind: "workflow", binding: "back/CLEANUP", className: "Cleanup", name: "cleanup" },
    ]);
    // The callee's code and objects do not choose the caller's drive.
    expect(d.drive).toEqual({ kind: "http" });
    expect(d.notes).toEqual([
      "D1 back/DB is the caller's database DB: set it up and read it as DB",
      "Durable Object back/LOCK is the namespace the caller binds to back's class Lock: set it up and read it under the caller's name",
      "R2 back/FILES is the caller's bucket FILES: set it up and read it as FILES",
    ]);
    expect(renderDraft(d)).toContain('workflow("back/CLEANUP", "Cleanup", { name: "cleanup" }),');
  });

  test("refuses a TOML config, a config with no main, and a module that does not exist", () => {
    const dir = project("refusals", {
      "wrangler.toml": 'name = "t"\n',
      "wrangler.json": { name: "t" },
    });
    expect(() => draftScenario({ config: join(dir, "wrangler.toml") })).toThrow(
      "a TOML config is not read",
    );
    expect(() => draftScenario({ config: join(dir, "wrangler.json") })).toThrow(
      "names no main module",
    );
    expect(() =>
      draftScenario({ config: join(dir, "wrangler.json"), entry: join(dir, "nope.ts") }),
    ).toThrow("does not exist");
  });
});

test("an Agent's route segment is the Agents SDK's kebab case of its binding", () => {
  expect(["POLL", "CHAT_ROOM", "ChatRoom", "MyAPI", "room_v2"].map(agentSegment)).toEqual([
    "poll",
    "chat-room",
    "chat-room",
    "my-a-p-i",
    "room-v2",
  ]);
});

test("migrations are ordered as wrangler orders them: by their number, compared as a number", () => {
  expect(
    ["10_seed.sql", "2_add.sql", "1_init.sql", "notes.sql", "0003_x.sql"].sort(migrationOrder),
  ).toEqual(["1_init.sql", "2_add.sql", "0003_x.sql", "10_seed.sql", "notes.sql"]);
});

test("a migrations_pattern is left to the author, with a note", () => {
  const dir = project("pattern", {
    "wrangler.json": {
      name: "p",
      main: "w.ts",
      d1_databases: [{ binding: "DB", migrations_pattern: "migrations/*/migration.sql" }],
    },
    "w.ts": worker,
    "migrations/0001/migration.sql": "",
    "migrations/stray.sql": "",
  });
  const d = draftScenario({ config: join(dir, "wrangler.json") });
  expect(d.setup).toEqual([{ kind: "d1", binding: "DB", schemaFile: "./schema.sql" }]);
  expect(d.notes).toHaveLength(1);
  expect(d.notes[0]).toContain("its migrations are the files matching migrations/*/migration.sql");
});

describe("renderDraft", () => {
  test("imports what it uses, marks every hole, and leaves the invariants empty", () => {
    const src = renderDraft({
      name: "s",
      worker: { entry: "./w.ts", config: "./wrangler.json" },
      drive: { kind: "queue", queue: "jobs" },
      setup: [
        { kind: "d1", binding: "DB", schemaFile: "./schema.sql" },
        { kind: "service", binding: "MAIL" },
      ],
      externals: [{ name: "mail", host: "mail.example" }],
      notes: ["a note"],
    });
    expect(src).toContain(
      'import { d1Schema, defineScenario, external, queue, service } from "eutaxy/cloudflare";',
    );
    expect(src).toContain("// Note: a note.");
    expect(src).toContain('drive: queue("jobs", [{ body: {} }]),');
    expect(src).toContain('external("mail", "mail.example"),');
    expect(src.match(/\/\/ TODO:/g)?.length).toBe(3);
    expect(src).toMatch(/invariants: \[\n(\s+\/\/.*\n)+\s+\],/);
  });
});

describe("runDraft", () => {
  test("prints the draft, writes it with --out, and never overwrites a file", () => {
    const dir = project("run", { "wrangler.json": { name: "r", main: "w.ts" }, "w.ts": worker });
    let out = "";
    let err = "";
    const io = {
      cwd: dir,
      json: false,
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      },
    };
    expect(runDraft(io)).toBe(0);
    expect(out).toContain('name: "r",');
    out = "";
    expect(runDraft({ ...io, out: "r.sim.ts" })).toBe(0);
    expect(readFileSync(join(dir, "r.sim.ts"), "utf8")).toContain('name: "r",');
    expect(out).toBe("Scenario drafted in r.sim.ts\n");
    expect(runDraft({ ...io, out: "r.sim.ts" })).toBe(3);
    expect(err).toContain("does not overwrite");
    expect(runDraft({ ...io, out: "nowhere/r.sim.ts" })).toBe(3);
    expect(err).toContain("does not exist");
    expect(runDraft({ ...io, cwd: root })).toBe(3);
    expect(err).toContain("no wrangler.jsonc or wrangler.json");
  });
});
