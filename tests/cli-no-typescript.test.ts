/**
 * The command in a project without the TypeScript compiler: every import of
 * `typescript` fails, as Node fails one of a package that is not installed
 * (`no-typescript.mjs`, preloaded). A scenario with no spec file is checked
 * all the same; what reads specs or runs an engine says it needs the
 * compiler, and exits 3.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bin, root } from "./eutaxy-command.ts";

const needs =
  "the TypeScript compiler, version 7.1 or later (typescript), which this project does not have: add it to the project's dev dependencies, or update the one there";

/** The command with `typescript` unresolvable: its exit status and its two streams. */
function withoutTypescript(
  args: readonly string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", join(root, "tests", "no-typescript.mjs"), bin, ...args],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", fail);
    child.once("close", (status) => done({ status: status ?? 1, stdout, stderr }));
  });
}

const check = (scenario: string, ...more: string[]) =>
  withoutTypescript([
    "check",
    scenario,
    "--seed",
    "gate",
    "--max-runs",
    "2",
    "--no-regression",
    "--budget-ms",
    "30000",
    ...more,
  ]);

describe("eutaxy without the TypeScript compiler", () => {
  test("the preload does what it says: an import of typescript fails as a missing package", async () => {
    const r = await new Promise<{ status: number; stderr: string }>((done) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          join(root, "tests", "no-typescript.mjs"),
          "--input-type=module",
          "-e",
          'await import("typescript/sync")',
        ],
        { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.once("close", (status) => done({ status: status ?? 1, stderr }));
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ERR_MODULE_NOT_FOUND");
  });

  test("help and a check of a scenario with no spec file run as with it", async () => {
    const help = await withoutTypescript(["help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage:");

    const r = await check("tests/systems/scripted-object-of-a-callee/sequential.sim.ts", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { verdict: { kind: string } }).verdict.kind).toBe("BOUNDED");
  }, 240_000);

  test("what reads specs or runs an engine says it needs the compiler, and exits 3", async () => {
    const [specs, prover, report, install] = await Promise.all([
      // A scenario whose directory holds a spec file.
      check("corpus/planted-bugs/refund-lost-update/scenario.sim.ts"),
      check("tests/systems/scripted-object-of-a-callee/sequential.sim.ts", "--prover", "lean"),
      withoutTypescript(["report", "corpus/prover-contracts/constructs/strings"]),
      withoutTypescript(["prover", "install", "smt"]),
    ]);
    expect(specs.status, specs.stderr).toBe(3);
    expect(specs.stderr).toBe(
      `the scenario's directory holds spec files (*.props.ts): reading a spec file needs ${needs}\n`,
    );
    expect(prover.status, prover.stderr).toBe(3);
    expect(prover.stderr).toBe(`the lean engine needs ${needs}\n`);
    expect(report.status, report.stderr).toBe(3);
    expect(report.stderr).toBe(`eutaxy report needs ${needs}\n`);
    expect(install.status, install.stderr).toBe(3);
    expect(install.stderr).toBe(`eutaxy prover install needs ${needs}\n`);
    for (const r of [specs, prover, report, install]) expect(r.stdout).toBe("");
  }, 240_000);

  test("a mistaken use of prover is told as one, not as a missing compiler", async () => {
    const r = await withoutTypescript(["prover", "install"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("prover takes: install <lean|smt>");
    expect(r.stderr).not.toContain("TypeScript");
  });

  test("the MCP server starts and answers, and reports each engine as not installed with why", async () => {
    const lines = await new Promise<string[]>((done, fail) => {
      const child = spawn(
        process.execPath,
        ["--import", join(root, "tests", "no-typescript.mjs"), bin, "mcp"],
        { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        // Both answers are in: end the server.
        if (stdout.split("\n").filter((l) => l !== "").length >= 2) child.stdin.end();
      });
      child.once("error", fail);
      child.once("close", () => done(stdout.split("\n").filter((l) => l !== "")));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prover_status", arguments: {} } })}\n`,
      );
    });
    const [initialized, status] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(initialized?.["id"]).toBe(1);
    expect(initialized?.["result"]).toBeDefined();
    expect(status?.["id"]).toBe(2);
    const text = JSON.stringify(status);
    expect(text).toContain("the lean engine needs the TypeScript compiler");
    expect(text).toContain("the smt engine needs the TypeScript compiler");
  }, 60_000);
});
