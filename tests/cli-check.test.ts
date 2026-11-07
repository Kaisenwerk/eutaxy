/** End to end: `eutaxy check` runs a scenario in workerd through Vitest and reports. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bin, eutaxy, root } from "./eutaxy-command.ts";

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
    const [a, b] = await Promise.all([run("twin-a"), run("twin-b")]);
    for (const r of [a, b]) {
      expect(r.status, r.stdout).toBe(1);
      expect((JSON.parse(r.stdout) as { verdict: { kind: string } }).verdict.kind).toBe("VIOLATED");
    }
    expect(existsSync(join(root, "corpus/planted-bugs/queue-duplicate-write/.eutaxy"))).toBe(false);
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

  test("reads the wrangler config the scenario names, which need not sit beside it", () => {
    // A copy of the payments example whose config lives in deploy/; nothing named wrangler.* sits beside
    // the scenario. Inside the example, so the copy resolves the example's dependencies.
    const example = join(root, "examples", "payments-queue");
    const dir = join(example, `cli-test-config-${process.pid}`);
    mkdirSync(join(dir, "deploy"), { recursive: true });
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
      writeFileSync(
        join(dir, "payments.sim.ts"),
        readFileSync(join(example, "payments.fixed.sim.ts"), "utf8").replace(
          '"./wrangler.jsonc"',
          '"./deploy/wrangler.jsonc"',
        ),
      );
      const r = eutaxy(["check", join(dir, "payments.sim.ts"), "--max-runs", "3", "--seed", "cli"]);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("BOUNDED  payments-fixed");
      // A config the scenario names that does not exist is an error that names it.
      writeFileSync(
        join(dir, "missing.sim.ts"),
        readFileSync(join(dir, "payments.sim.ts"), "utf8").replace("./deploy/", "./nowhere/"),
      );
      const missing = eutaxy(["check", join(dir, "missing.sim.ts")]);
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
    expect(eutaxy(["nope"]).status).toBe(3);
    expect(eutaxy(["help"]).stdout).toContain("Usage:");
  });
});
