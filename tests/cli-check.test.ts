/** End to end: `eutaxy check` runs a scenario in workerd through Vitest and reports. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bin, eutaxy, eutaxyWithin, root } from "./eutaxy-command.ts";

describe("eutaxy check", () => {
  test("two checks of one scenario at once each read their own report and leave no files behind", async () => {
    const { spawn } = await import("node:child_process");
    const run = (seed: string) =>
      new Promise<{ status: number | null; stdout: string }>((done) => {
        const child = spawn(
          process.execPath,
          [
            bin,
            "check",
            "corpus/planted-bugs/queue-duplicate-write/scenario.sim.ts",
            "--json",
            "--seed",
            seed,
            "--no-regression",
            "--budget-ms",
            "30000",
          ],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.on("close", (status) => done({ status, stdout }));
      });
    // Vite's cache is among what a check must not leave in the scenario's directory.
    const viteCache = join(root, "corpus/planted-bugs/queue-duplicate-write/node_modules/.vite");
    rmSync(viteCache, { recursive: true, force: true });
    const [a, b] = await Promise.all([run("twin-a"), run("twin-b")]);
    for (const r of [a, b]) {
      expect(r.status, r.stdout).toBe(1);
      expect((JSON.parse(r.stdout) as { verdict: { kind: string } }).verdict.kind).toBe("VIOLATED");
    }
    expect(existsSync(join(root, "corpus/planted-bugs/queue-duplicate-write/.eutaxy"))).toBe(false);
    expect(existsSync(viteCache)).toBe(false);
  }, 240_000);

  test("a scenario with a callee: the command adds the callee's isolate, runs both Workers and writes a regression test naming the callee", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-cli-callee-"));
    try {
      const outFile = join(out, "callee.regression.test.ts");
      const r = eutaxy([
        "check",
        "corpus/planted-bugs/callee-reserve-twice/scenario.sim.ts",
        "--json",
        "--seed",
        "cli",
        "--out",
        outFile,
      ]);
      expect(r.status, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout) as {
        verdict: { kind: string; violation: { invariant: string }; assumptions: string[] };
      };
      expect(report.verdict.kind).toBe("VIOLATED");
      expect(report.verdict.violation.invariant).toBe("one-reservation-per-order");
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain('import * as callee_INVENTORY from "../../');
      expect(src).toContain(
        'schemas: { DB: schema_DB, "inventory/DB": schema_inventory_DB }, callees: { INVENTORY: { name: "inventory", exports: callee_INVENTORY } }',
      );
      expect(existsSync(join(root, "corpus/planted-bugs/callee-reserve-twice/.eutaxy"))).toBe(
        false,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  test("reports a violation as JSON, writes the regression test, exits 1", () => {
    const out = mkdtempSync(join(tmpdir(), "eutaxy-cli-"));
    try {
      const outFile = join(out, "dup.regression.test.ts");
      const r = eutaxy([
        "check",
        "corpus/planted-bugs/queue-duplicate-write/scenario.sim.ts",
        "--json",
        "--seed",
        "cli",
        "--out",
        outFile,
      ]);
      expect(r.status, r.stderr).toBe(1);
      const report = JSON.parse(r.stdout) as {
        schemaVersion: number;
        verdict: { kind: string; violation: { invariant: string } };
      };
      expect(report.schemaVersion).toBe(1);
      expect(report.verdict.kind).toBe("VIOLATED");
      expect(report.verdict.violation.invariant).toBe("payment-recorded-once");
      expect(existsSync(outFile)).toBe(true);
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain("holds on the recorded schedule");
      expect(src).toContain(
        "createCloudflarePlatform({ env, handler, schemas: { DB: schema_DB } })",
      );
      expect(existsSync(join(root, "corpus/planted-bugs/queue-duplicate-write/.eutaxy"))).toBe(
        false,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  test("reports BOUNDED as text and exits 0", () => {
    const r = eutaxy([
      "check",
      "corpus/differential/d1-ledger/scenario.sim.ts",
      "--max-runs",
      "3",
      "--seed",
      "cli",
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("BOUNDED  d1-ledger");
    expect(r.stdout).toContain("This is not a proof.");
  }, 180_000);

  test("reads the wrangler config, the Worker's entry and the schema the scenario names, none of which need sit beside it", () => {
    // A copy of the payments example whose config lives in deploy/ and whose scenario lives in system/,
    // apart from the Worker and the schema it names: nothing but the scenario is in its directory.
    // Inside the example, so the copy resolves the example's dependencies.
    const example = join(root, "examples", "payments-queue");
    const dir = join(example, `cli-test-config-${process.pid}`);
    mkdirSync(join(dir, "deploy"), { recursive: true });
    mkdirSync(join(dir, "system"), { recursive: true });
    try {
      for (const f of ["worker.fixed.ts", "worker.ts", "schema.fixed.sql"])
        writeFileSync(join(dir, f), readFileSync(join(example, f)));
      const config = JSON.parse(readFileSync(join(example, "wrangler.jsonc"), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(dir, "deploy", "wrangler.jsonc"),
        JSON.stringify({ ...config, main: "../worker.fixed.ts" }),
      );
      const scenario = readFileSync(join(example, "payments.fixed.sim.ts"), "utf8")
        .replace('"./wrangler.jsonc"', '"../deploy/wrangler.jsonc"')
        .replace('"./worker.fixed.ts"', '"../worker.fixed.ts"')
        .replace('"./schema.fixed.sql"', '"../schema.fixed.sql"');
      expect(scenario.match(/"\.\.\//g)).toHaveLength(3);
      writeFileSync(join(dir, "system", "payments.sim.ts"), scenario);
      const r = eutaxy([
        "check",
        join(dir, "system", "payments.sim.ts"),
        "--max-runs",
        "3",
        "--seed",
        "cli",
        "--no-regression",
      ]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("BOUNDED  payments-fixed");
      // A config the scenario names that does not exist is an error that names it.
      writeFileSync(
        join(dir, "system", "missing.sim.ts"),
        scenario.replace("../deploy/", "../nowhere/"),
      );
      const missing = eutaxy(["check", join(dir, "system", "missing.sim.ts")]);
      expect(missing.status).toBe(3);
      expect(missing.stderr).toContain("the scenario's wrangler config was not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("several d1Schema steps on one binding are applied in order, a migration per file", () => {
    // The payments example's table built by two migrations: the second adds the column the Worker writes,
    // so the check runs only if both are applied, the first first.
    const example = join(root, "examples", "payments-queue");
    const dir = join(example, `cli-test-migrations-${process.pid}`);
    mkdirSync(join(dir, "migrations"), { recursive: true });
    try {
      writeFileSync(join(dir, "worker.ts"), readFileSync(join(example, "worker.fixed.ts")));
      writeFileSync(join(dir, "wrangler.jsonc"), readFileSync(join(example, "wrangler.jsonc")));
      writeFileSync(
        join(dir, "migrations", "0001_init.sql"),
        "CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL UNIQUE);\n",
      );
      writeFileSync(
        join(dir, "migrations", "0002_amount.sql"),
        "ALTER TABLE payments ADD amount_cents INTEGER NOT NULL DEFAULT 0;\n",
      );
      writeFileSync(
        join(dir, "payments.sim.ts"),
        readFileSync(join(example, "payments.fixed.sim.ts"), "utf8")
          .replace(
            'setup: [d1Schema("DB", "./schema.fixed.sql")]',
            'setup: [d1Schema("DB", "./migrations/0001_init.sql"), d1Schema("DB", "./migrations/0002_amount.sql")]',
          )
          .replace('"./worker.fixed.ts"', '"./worker.ts"'),
      );
      const r = eutaxy(["check", join(dir, "payments.sim.ts"), "--max-runs", "3", "--seed", "cli"]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("BOUNDED  payments-fixed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("a scripted service binding to a Worker the isolate does not hold still runs", () => {
    // The scripted-billing entry, its binding pointed at the billing Worker by name (not at itself, as
    // the corpus config does so that workerd starts): the scenario scripts it, so it is never called.
    const entry = join(root, "corpus", "planted-bugs", "service-charge-twice");
    const dir = join(root, "examples", "payments-queue", `cli-test-service-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      for (const f of ["worker.ts", "scenario.sim.ts", "schema.sql"])
        writeFileSync(join(dir, f), readFileSync(join(entry, f)));
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        readFileSync(join(entry, "wrangler.jsonc"), "utf8").replace(
          '"service": "planted-service-charge-twice"',
          '"service": "billing"',
        ),
      );
      const r = eutaxy(["check", join(dir, "scenario.sim.ts"), "--seed", "cli", "--no-regression"]);
      expect(r.stderr).not.toContain("no such service is defined");
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stdout).toContain("Invariant charged-once is violated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("an object's call on a scripted service binding through its own env is answered from the script", () => {
    // The runtime hands an object the Worker's real env, where the binding is the isolate's placeholder:
    // left alone, the call fails inside the object, whose own error handling takes that for the model's
    // answer. The scenario's script answers it instead, as an effect of the object's work after its
    // answer, so every run ends done, in the steps the script gave.
    const dir = join(root, "examples", "payments-queue", `cli-test-object-env-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({
          name: "cli-test-object-env",
          main: "worker.ts",
          compatibility_date: "2026-10-01",
          durable_objects: { bindings: [{ name: "RUNNER", class_name: "Runner" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Runner"] }],
          services: [{ binding: "MODEL", service: "model-worker" }],
        }),
      );
      writeFileSync(
        join(dir, "worker.ts"),
        `import { DurableObject } from "cloudflare:workers";
interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
  readonly MODEL: { complete(runId: string): Promise<{ steps: number }> };
}
export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  }
  async start(runId: string): Promise<{ accepted: true }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO runs (id, status) VALUES (?, 'queued')", runId);
    void this.execute(runId);
    return { accepted: true };
  }
  private async execute(runId: string): Promise<void> {
    try {
      const { steps } = await this.env.MODEL.complete(runId);
      this.ctx.storage.sql.exec("UPDATE runs SET status = ? WHERE id = ?", \`done in \${steps}\`, runId);
    } catch {
      this.ctx.storage.sql.exec("UPDATE runs SET status = 'failed' WHERE id = ?", runId);
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runId = new URL(request.url).pathname.slice(1);
    return Response.json(await env.RUNNER.get(env.RUNNER.idFromName("r")).start(runId));
  },
};
`,
      );
      writeFileSync(
        join(dir, "scenario.sim.ts"),
        `import { defineScenario, durableObject, durableObjectTable, everyRow, http, service } from "eutaxy/cloudflare";
export default defineScenario({
  name: "object-env",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("RUNNER", { r: {} }), service("MODEL", { methods: { complete: { returns: { steps: 2 } } } })],
  drive: http([{ id: "run-1", path: "/run-1", method: "POST" }], { retries: 0 }),
  externals: [],
  invariants: [
    everyRow("every-run-is-done", durableObjectTable("RUNNER", "r", "runs"), [
      { column: "status", op: "eq", value: "done in 2" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 0, maxRedeliveries: 0, budgetMs: 2000 },
});
`,
      );
      const r = eutaxy(["check", join(dir, "scenario.sim.ts"), "--seed", "cli", "--no-regression"]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("BOUNDED  object-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("an object woken at the end of a run whose constructor leaves a timer running is UNSUPPORTED, not snapshotted without that work", () => {
    // A crash on the object's last call resets it with nothing left to enter it, so it is woken
    // inside the run for the snapshot. Its constructor sets a timer and does not wait: workerd
    // carries no context of the wake into the constructor, so that work would not be followed.
    const dir = join(root, "examples", "payments-queue", `cli-test-wake-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({
          name: "cli-test-wake",
          main: "worker.ts",
          compatibility_date: "2026-10-01",
          durable_objects: { bindings: [{ name: "RUNNER", class_name: "Runner" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Runner"] }],
        }),
      );
      writeFileSync(
        join(dir, "worker.ts"),
        `import { DurableObject } from "cloudflare:workers";
interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
}
export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    // Work the constructor starts and does not wait for.
    setTimeout(() => this.ctx.storage.sql.exec("INSERT OR IGNORE INTO runs (id, status) VALUES ('warm', 'late')"), 10);
  }
  async start(runId: string): Promise<{ accepted: true }> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO runs (id, status) VALUES (?, 'queued')", runId);
    const res = await fetch("https://model.example/plan", { method: "POST" });
    this.ctx.storage.sql.exec("UPDATE runs SET status = ? WHERE id = ?", res.ok ? "done" : "failed", runId);
    return { accepted: true };
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runId = new URL(request.url).pathname.slice(1);
    return Response.json(await env.RUNNER.get(env.RUNNER.idFromName("r")).start(runId));
  },
};
`,
      );
      writeFileSync(
        join(dir, "scenario.sim.ts"),
        `import { defineScenario, durableObject, durableObjectTable, external, http, unique } from "eutaxy/cloudflare";
export default defineScenario({
  name: "wake",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("RUNNER", { r: {} })],
  drive: http([{ id: "run-1", path: "/run-1", method: "POST" }], { retries: 0 }),
  externals: [external("model", "model.example", { responses: [{ status: 200, body: {} }] })],
  invariants: [unique("one-row-per-run", durableObjectTable("RUNNER", "r", "runs"), "id")],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, budgetMs: 2000 },
});
`,
      );
      const r = eutaxy(["check", join(dir, "scenario.sim.ts"), "--seed", "cli", "--no-regression"]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
      expect(r.stdout).toContain(
        "Durable Object RUNNER r was woken at the end of the run and its constructor left a timer running",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("a constructor that awaits a timer behind its input gate is run as the object's code: the check ends, and the call sees what it prepared", async () => {
    // The object warms up in its constructor, holding its input gate until a timer has passed. The
    // timer is virtual and the constructor's code is the object's: nobody else can fire it. Left
    // outside the model, the first call never entered the object and the check never ended.
    const dir = join(root, "examples", "payments-queue", `cli-test-ctor-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({
          name: "cli-test-ctor",
          main: "worker.ts",
          compatibility_date: "2026-10-01",
          durable_objects: { bindings: [{ name: "RUNNER", class_name: "Runner" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Runner"] }],
        }),
      );
      writeFileSync(
        join(dir, "worker.ts"),
        `import { DurableObject } from "cloudflare:workers";
interface Env {
  readonly RUNNER: DurableObjectNamespace<Runner>;
}
export class Runner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    void this.ctx.blockConcurrencyWhile(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO runs (id, status) VALUES ('warm', 'ready')");
    });
  }
  async start(runId: string): Promise<{ accepted: true }> {
    const warm = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM runs WHERE id = 'warm'").toArray()[0];
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO runs (id, status) VALUES (?, ?)", runId, warm?.status ?? "cold");
    return { accepted: true };
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runId = new URL(request.url).pathname.slice(1);
    return Response.json(await env.RUNNER.get(env.RUNNER.idFromName("r")).start(runId));
  },
};
`,
      );
      writeFileSync(
        join(dir, "scenario.sim.ts"),
        `import { defineScenario, durableObject, durableObjectTable, everyRow, http } from "eutaxy/cloudflare";
export default defineScenario({
  name: "ctor",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [durableObject("RUNNER", { r: {} })],
  drive: http([{ id: "run-1", path: "/run-1", method: "POST" }], { retries: 0 }),
  externals: [],
  // The call entered the object only once the constructor's warm-up was done, as the gate holds it.
  invariants: [
    everyRow("every-run-saw-the-warm-up", durableObjectTable("RUNNER", "r", "runs"), [
      { column: "status", op: "eq", value: "ready" },
    ]),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 0, budgetMs: 2000 },
});
`,
      );
      const r = await eutaxyWithin(
        [
          "check",
          join(dir, "scenario.sim.ts"),
          "--seed",
          "cli",
          "--max-runs",
          "20",
          "--no-regression",
        ],
        60_000,
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("BOUNDED  ctor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("fails clearly without a scenario or a wrangler config", () => {
    expect(eutaxy(["check"]).status).toBe(3);
    const bad = eutaxy([
      "check",
      "corpus/differential/d1-ledger/scenario.sim.ts",
      "--max-runs",
      "typo",
    ]);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain("--max-runs must be a positive integer");
    for (const budget of ["soon", "0", "-5"]) {
      const r = eutaxy([
        "check",
        "corpus/differential/d1-ledger/scenario.sim.ts",
        "--budget-ms",
        budget,
      ]);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("--budget-ms must be a positive integer");
    }
    expect(
      eutaxy(["check", "corpus/differential/d1-ledger/scenario.sim.ts", "--max-runs", "0"]).status,
    ).toBe(3);
    expect(eutaxy(["check", "nope.sim.ts"]).status).toBe(3);
    const bare = eutaxy(["check", "corpus/differential/d1-ledger/scenario.sim.ts", "--seed"]);
    expect(bare.status).toBe(3);
    expect(bare.stderr).toContain("--seed needs a value");
    // Another command's flag is refused, not ignored.
    const other = eutaxy([
      "check",
      "corpus/differential/d1-ledger/scenario.sim.ts",
      "--worker",
      "worker.ts",
      "--goals",
    ]);
    expect(other.status).toBe(3);
    expect(other.stderr).toBe("check does not take --worker\n");
    const two = eutaxy(["check", "a.sim.ts", "b.sim.ts"]);
    expect(two.status).toBe(3);
    expect(two.stderr).toContain("check takes one scenario file");
    expect(eutaxy(["nope"]).status).toBe(3);
    expect(eutaxy(["help"]).stdout).toContain("Usage:");
  });
});
