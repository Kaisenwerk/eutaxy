/** The callee configs `eutaxy check` reads, and the sources it generates from them. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callee } from "@eutaxy/cloudflare";
import { afterAll, describe, expect, test } from "vitest";
import {
  calleeSteps,
  classAlias,
  isolateBindings,
  loadScenario,
  mainModuleSource,
  mentionsCallee,
  miniflareOptionsSource,
  neverCalled,
  parseJsonc,
  qualified,
  readCalleeConfig,
  workerName,
} from "./callees.ts";

const dir = mkdtempSync(join(tmpdir(), "eutaxy-callees-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseJsonc", () => {
  test("drops comments outside strings and trailing commas, and nothing inside strings", () => {
    expect(
      parseJsonc(`{
        // a line comment
        "name": "a//b", /* block */ "list": [1, 2, /* c */ ],
        "url": "https://x/y", // trailing
      }`),
    ).toEqual({ name: "a//b", list: [1, 2], url: "https://x/y" });
    expect(parseJsonc('{"vars":{"VALUE":"a,}b,]c"}}')).toEqual({ vars: { VALUE: "a,}b,]c" } });
  });
});

describe("a callee's config", () => {
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(
    config,
    `{
      "name": "inventory",
      "main": "worker.ts",
      "compatibility_date": "2026-10-01",
      "vars": { "REGION": "eu" },
      "d1_databases": [{ "binding": "DB", "database_name": "inv", "database_id": "inv-id" }],
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "inv-files" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "kv-1" }],
      "durable_objects": { "bindings": [
        { "name": "LEASES", "class_name": "Lease" },
        { "name": "REMOTE", "class_name": "Other", "script_name": "elsewhere" }
      ] },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Lease"] }],
      "workflows": [{ "binding": "FLOW", "name": "fulfilment", "class_name": "Fulfilment" }],
      "services": [{ "binding": "PARTNER", "service": "partner" }],
      "queues": { "producers": [{ "binding": "EVENTS", "queue": "inv-events" }] },
      "analytics_engine_datasets": [{ "binding": "AE" }]
    }`,
  );
  const step = { binding: "INVENTORY", entry: "./inventory/worker.ts", config: "./wrangler.jsonc" };

  test("is read into the resources the isolate needs, under the Worker's name", () => {
    const c = readCalleeConfig(step, dir);
    expect(c.name).toBe("inventory");
    expect(c.entry).toBe(join(dir, "inventory/worker.ts"));
    expect(c.d1).toEqual([{ binding: "DB", id: "inv-id" }]);
    expect(c.r2).toEqual([{ binding: "FILES", bucket: "inv-files" }]);
    expect(c.kv).toEqual([{ binding: "CACHE", id: "kv-1" }]);
    expect(c.durableObjects).toEqual([{ binding: "LEASES", className: "Lease", sqlite: true }]);
    expect(c.workflows).toEqual([{ binding: "FLOW", className: "Fulfilment", name: "fulfilment" }]);
    expect(c.services).toEqual(["PARTNER"]);
    expect(c.queues).toEqual([{ binding: "EVENTS", queue: "inv-events" }]);
    expect(c.vars).toEqual({ REGION: "eu" });
    expect(c.notAdded).toEqual([
      "durable_objects binding REMOTE (script_name elsewhere: a class of another Worker)",
      "analytics_engine_datasets",
    ]);
    expect(workerName(config)).toBe("inventory");
  });

  test("migrations are applied in order: a SQLite class stays so through a rename, until deleted", () => {
    const migrated = join(dir, "migrated.jsonc");
    writeFileSync(
      migrated,
      `{ "name": "inv", "durable_objects": { "bindings": [
          { "name": "A", "class_name": "Lease2" }, { "name": "B", "class_name": "Gone" }, { "name": "C", "class_name": "Kv" }
        ] },
        "migrations": [
          { "tag": "v1", "new_sqlite_classes": ["Lease", "Gone"], "new_classes": ["Kv"] },
          { "tag": "v2", "renamed_classes": [{ "from": "Lease", "to": "Lease2" }], "deleted_classes": ["Gone"] }
        ] }`,
    );
    const c = readCalleeConfig({ ...step, config: "./migrated.jsonc" }, dir);
    expect(c.durableObjects).toEqual([
      { binding: "A", className: "Lease2", sqlite: true },
      { binding: "B", className: "Gone", sqlite: false },
      { binding: "C", className: "Kv", sqlite: false },
    ]);
  });

  test("a config without a name, or a TOML one, is refused", () => {
    const nameless = join(dir, "nameless.json");
    writeFileSync(nameless, "{}");
    expect(() => readCalleeConfig({ ...step, config: "./nameless.json" }, dir)).toThrow("no name");
    expect(() => readCalleeConfig({ ...step, config: "./wrangler.toml" }, dir)).toThrow(
      "TOML config is not read",
    );
    expect(workerName(join(dir, "missing.jsonc"))).toBeUndefined();
  });

  test("the generated main module re-exports the caller as it is and the callee's classes as aliases that see the callee's env", () => {
    const c = readCalleeConfig(step, dir);
    const src = mainModuleSource(join(dir, ".eutaxy"), join(dir, "worker.ts"), [c]);
    expect(src).toBe(`// Generated by eutaxy check; deleted after the run.
import { calleeEnv } from "eutaxy/cloudflare";
export * from "../worker.ts";
export { default } from "../worker.ts";
import { Lease as callee0_Lease, Fulfilment as callee0_Fulfilment } from "../inventory/worker.ts";
export class inventory__Lease extends callee0_Lease {
  constructor(ctx: unknown, env: object) {
    super(ctx as never, calleeEnv("inventory", env) as never);
  }
}
export class inventory__Fulfilment extends callee0_Fulfilment {
  constructor(ctx: unknown, env: object) {
    super(ctx as never, calleeEnv("inventory", env) as never);
  }
}
`);
    const bare = mainModuleSource(join(dir, ".eutaxy"), join(dir, "worker.ts"), [
      { ...c, durableObjects: [], workflows: [] },
    ]);
    expect(bare).not.toContain("calleeEnv");
    // Two bindings to one Worker: its classes are adapted once.
    const twice = mainModuleSource(join(dir, ".eutaxy"), join(dir, "worker.ts"), [
      c,
      { ...c, binding: "INVENTORY_ADMIN" },
    ]);
    expect(twice.match(/export class inventory__Lease/g)).toHaveLength(1);
    expect(classAlias("1st-worker", "Lease")).toBe("_1st_worker__Lease");
    expect(classAlias("my-worker", "Lease")).toBe("my_worker__Lease");
    expect(qualified("inventory", "DB")).toBe("inventory/DB");
  });

  test("the miniflare options add every resource under its qualified name; service bindings are answered by the config's function", () => {
    const c = readCalleeConfig(step, dir);
    const never = () => new Response("never");
    const options = new Function(neverCalled, `return ${miniflareOptionsSource([c])};`)(
      never,
    ) as Record<string, unknown>;
    expect(options).toEqual({
      d1Databases: { "inventory/DB": "inv-id" },
      r2Buckets: { "inventory/FILES": "inv-files" },
      kvNamespaces: { "inventory/CACHE": "kv-1" },
      durableObjects: { "inventory/LEASES": { className: "inventory__Lease", useSQLite: true } },
      workflows: { "inventory/FLOW": { name: "fulfilment", className: "inventory__Fulfilment" } },
      serviceBindings: { INVENTORY: never, "inventory/PARTNER": never },
      queueProducers: { "inventory/EVENTS": "inv-events" },
      bindings: { "inventory/REGION": "eu" },
    });
    expect(miniflareOptionsSource([])).toBe("{}");
    const bare = {
      ...c,
      d1: [],
      r2: [],
      kv: [],
      durableObjects: [],
      workflows: [],
      queues: [],
      vars: {},
      services: [],
    };
    expect(miniflareOptionsSource([bare])).toBe(`{"serviceBindings":{"INVENTORY":${neverCalled}}}`);
  });
});

describe("loading the scenario in Node", () => {
  test("follows a .js import to its .ts module, as Vite does, and returns the setup and the Worker", async () => {
    const sdir = join(dir, "scenario");
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "setup.ts"), 'export const entry = "./worker.ts";\n');
    writeFileSync(
      join(sdir, "s.sim.ts"),
      `import { entry } from "./setup.js";
export default { setup: [{ kind: "callee", binding: "A", entry: "./a.ts", config: "./a.jsonc" }], worker: { entry, config: "./wrangler.jsonc" } };
`,
    );
    const loaded = await loadScenario(join(sdir, "s.sim.ts"));
    expect(loaded.worker.entry).toBe("./worker.ts");
    // Loaded afresh each time: an edit is seen, as a long-lived process needs.
    writeFileSync(join(sdir, "setup.ts"), 'export const entry = "./other.ts";\n');
    expect((await loadScenario(join(sdir, "s.sim.ts"))).worker.entry).toBe("./other.ts");
    await expect(loadScenario(join(sdir, "missing.sim.ts"))).rejects.toThrow(
      /Cannot find module|not found/,
    );
    writeFileSync(join(sdir, "bad.sim.ts"), "export default 3;\n");
    await expect(loadScenario(join(sdir, "bad.sim.ts"))).rejects.toThrow("not a scenario");
    expect(calleeSteps(loaded.setup)).toEqual([
      { binding: "A", entry: "./a.ts", config: "./a.jsonc" },
    ]);
    const inventory = {
      binding: "INVENTORY",
      entry: "./inventory/worker.ts",
      config: "./wrangler.jsonc",
    };
    expect(isolateBindings([readCalleeConfig(inventory, dir)])).toEqual([
      "inventory/DB",
      "inventory/FILES",
      "inventory/CACHE",
      "inventory/LEASES",
      "inventory/FLOW",
      "inventory/PARTNER",
      "inventory/EVENTS",
      "inventory/REGION",
    ]);
  });
});

describe("the scenario side", () => {
  test("callee steps are read from a setup; a source mentions a callee or not", () => {
    const setup = [
      { kind: "d1", binding: "DB", schemaFile: "./s.sql" },
      callee("INVENTORY", { entry: "./inventory/worker.ts", config: "./inventory/wrangler.jsonc" }),
      callee("OTHER", { entry: "./o.ts", config: "./o.jsonc", entrypoint: "Named" }),
    ];
    expect(calleeSteps(setup)).toEqual([
      {
        binding: "INVENTORY",
        entry: "./inventory/worker.ts",
        config: "./inventory/wrangler.jsonc",
      },
      { binding: "OTHER", entry: "./o.ts", config: "./o.jsonc", entrypoint: "Named" },
    ]);
    expect(mentionsCallee('setup: [callee("X", { entry, config })]')).toBe(true);
    expect(mentionsCallee("service('X')")).toBe(false);
  });
});
