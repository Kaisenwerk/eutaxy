/**
 * End to end, the v0.12 gate: the eutaxy MCP server over stdio, in both
 * protocol eras. A check comes back with its verdict and a replayable
 * regression test; with the Lean engine installed, `goals` writes the open
 * goals of a module, a proof supplied from them reaches PROVEN through
 * `prove`, and a proof whose module changed since is stale, never PROVEN.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages", "eutaxy", "bin", "eutaxy.mjs");

/** One server process: a line in, the matching response out, by id. */
class Server {
  readonly child: ChildProcess;
  readonly waiting = new Map<number, (r: Record<string, unknown>) => void>();
  readonly stderr: string[] = [];
  next = 1;

  constructor() {
    this.child = spawn(process.execPath, [bin, "mcp"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const m = JSON.parse(line) as Record<string, unknown>;
      const id = m["id"] as number;
      this.waiting.get(id)?.(m);
      this.waiting.delete(id);
    });
    this.child.stderr?.on("data", (d: Buffer) => this.stderr.push(d.toString()));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Close stdin: the server exits on its own. */
  close(): Promise<number | null> {
    return new Promise((done) => {
      this.child.once("close", (code) => done(code));
      this.child.stdin?.end();
    });
  }
}

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "eutaxy-tests", version: "0" },
};
type Result = { result?: Record<string, unknown>; error?: { code: number; message: string } };
const resultOf = (r: Record<string, unknown>): Record<string, unknown> =>
  (r as Result).result ?? {};
const structured = (r: Record<string, unknown>) =>
  ((r as Result).result?.["structuredContent"] ?? {}) as {
    exitCode: number;
    report: Record<string, unknown>;
  };

let server: Server;
beforeAll(() => {
  server = new Server();
});
afterAll(async () => {
  expect(await server.close()).toBe(0);
});

describe("eutaxy mcp", () => {
  test("the handshake era: initialize, tools/list, a check with its verdict and regression test", async () => {
    // A scenario no other test file checks at the same time: two checks of one directory may run at once, but
    // a test asserting the directory is gone afterwards must be alone in it.
    const init = (await server.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "eutaxy-tests", version: "0" },
    })) as Result;
    expect(init.result?.["protocolVersion"]).toBe("2025-11-25");
    expect((resultOf(init)["serverInfo"] as { name: string }).name).toBe("eutaxy");
    server.notify("notifications/initialized");
    const list = (await server.request("tools/list")) as Result;
    expect((resultOf(list)["tools"] as { name: string }[]).map((t) => t.name)).toEqual([
      "check",
      "report",
      "goals",
      "prove",
      "draft",
      "prover_status",
    ]);
    const out = mkdtempSync(join(tmpdir(), "eutaxy-mcp-"));
    try {
      const outFile = join(out, "dup.regression.test.ts");
      const call = await server.request("tools/call", {
        name: "check",
        arguments: {
          scenario: "corpus/planted-bugs/queue-charge-twice/scenario.sim.ts",
          seed: "mcp",
          budgetMs: 30_000,
          out: outFile,
        },
      });
      const s = structured(call);
      expect((call as Result).result?.["isError"], JSON.stringify(call)).toBe(false);
      expect(s.exitCode).toBe(1);
      expect((s.report["verdict"] as { kind: string }).kind).toBe("VIOLATED");
      expect(s.report["regressionTest"]).toBe(relative(root, outFile).split("\\").join("/"));
      expect(existsSync(outFile)).toBe(true);
      expect(readFileSync(outFile, "utf8")).toContain("holds on the recorded schedule");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);

  test("the stateless era: discover, and prover_status", async () => {
    const discover = (await server.request("server/discover", { _meta: modernMeta })) as Result;
    expect(discover.result?.["resultType"]).toBe("complete");
    expect(discover.result?.["supportedVersions"]).toEqual(["2026-07-28"]);
    const status = (await server.request("tools/call", {
      name: "prover_status",
      _meta: modernMeta,
    })) as Result;
    const engines = (
      resultOf(status)["structuredContent"] as {
        engines: { name: string; installed: boolean }[];
      }
    ).engines;
    expect(engines.map((e) => e.name)).toEqual(["lean", "smt"]);
  });
});

/** Whether the Lean engine is installed here, asked of the server itself. */
async function leanInstalled(): Promise<boolean> {
  const probe = new Server();
  const status = (await probe.request("tools/call", {
    name: "prover_status",
    _meta: modernMeta,
  })) as Result;
  await probe.close();
  const engines = (
    resultOf(status)["structuredContent"] as {
      engines: { name: string; installed: boolean }[];
    }
  ).engines;
  return engines.some((e) => e.name === "lean" && e.installed);
}
const hasLean = await leanInstalled();
const required = process.env["EUTAXY_REQUIRE_LEAN"] === "1";

describe.skipIf(!hasLean && !required)("the proof loop through the server", () => {
  // A copy of the contract corpus's lists entry, without its proof file, beside it, where its imports
  // resolve; .probe-* is gitignored.
  const scratch = join(root, "corpus/prover-contracts", `.probe-mcp-${process.pid}`);
  const fixture = join(root, "corpus/prover-contracts/constructs/lists");
  beforeAll(() => {
    mkdirSync(scratch, { recursive: true });
    copyFileSync(join(fixture, "domain.ts"), join(scratch, "domain.ts"));
    copyFileSync(join(fixture, "domain.props.ts"), join(scratch, "domain.props.ts"));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const rel = (p: string) => relative(root, p).split("\\").join("/");

  test("goals writes the open goals, a proof supplied from them is PROVEN, and the proof is stale once the module changes", async () => {
    const goals = await server.request("tools/call", {
      name: "goals",
      arguments: { dir: rel(scratch) },
      _meta: modernMeta,
    });
    const g = structured(goals);
    expect((goals as Result).result?.["isError"], JSON.stringify(goals)).toBe(false);
    const open = g.report["goals"] as { property: string; file: string; statement: string }[];
    expect(open.map((o) => o.property)).toEqual(
      expect.arrayContaining(["countIsProduct", "sumOfOne"]),
    );
    const goalFile = join(scratch, "domain.props.goals.lean");
    expect(open[0]?.file).toBe(rel(goalFile));
    const goalText = readFileSync(goalFile, "utf8");
    expect(goalText).toContain("-- proof: countIsProduct\n  -- tactics here");
    expect(open.find((o) => o.property === "countIsProduct")?.statement).toContain(
      "f_scheduleCount",
    );

    // The proofs the contract corpus supplies, under the goal file's header (the hashes), as an agent would write them.
    const header = goalText
      .split("\n")
      .filter((l) => l.startsWith("-- eutaxy-"))
      .join("\n");
    const proofs = readFileSync(join(fixture, "domain.props.lean"), "utf8");
    writeFileSync(join(scratch, "domain.props.lean"), `${header}\n\n${proofs}`);
    const proved = await server.request("tools/call", {
      name: "prove",
      arguments: { spec: rel(join(scratch, "domain.props.ts")) },
      _meta: modernMeta,
    });
    const p = structured(proved);
    const specs = p.report["specs"] as { property: string; kind: string; reason?: string }[];
    expect(specs.find((s) => s.property === "countIsProduct")?.kind, JSON.stringify(specs)).toBe(
      "PROVEN",
    );
    expect(specs.find((s) => s.property === "sumOfOne")?.kind).toBe("PROVEN");

    // The module changes under the proofs: stale, whatever the proofs would prove.
    writeFileSync(
      join(scratch, "domain.ts"),
      `${readFileSync(join(scratch, "domain.ts"), "utf8")}\n// changed\n`,
    );
    const stale = structured(
      await server.request("tools/call", {
        name: "prove",
        arguments: { spec: rel(join(scratch, "domain.props.ts")) },
        _meta: modernMeta,
      }),
    );
    const after = stale.report["specs"] as {
      property: string;
      kind: string;
      reason?: string;
      assumptions?: string[];
    }[];
    const count = after.find((s) => s.property === "countIsProduct");
    // The verdict falls back to what the lower rungs found (TESTED here); the engine's answer stands
    // among its notes, saying which file moved.
    expect(count?.kind).not.toBe("PROVEN");
    expect([count?.reason, ...(count?.assumptions ?? [])].join("\n")).toMatch(
      /domain\.props\.lean is stale: the module changed since its proofs were written/,
    );
    expect(after.some((s) => s.kind === "PROVEN" && s.property === "countIsProduct")).toBe(false);
  }, 600_000);
});
