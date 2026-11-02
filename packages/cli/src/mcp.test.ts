import { describe, expect, test } from "vitest";
import {
  handleLine,
  legacyVersions,
  type McpContext,
  modernVersions,
  type Runners,
  serverInfo,
  tools,
} from "./mcp.ts";

const runners: Runners = {
  check: async (o) => {
    o.stderr("a line of progress\n");
    o.stdout(
      `${JSON.stringify({
        schemaVersion: 1,
        verdict: { kind: "VIOLATED", violation: { invariant: "once" } },
        regressionTest: `${o.scenario.replace(/\.sim\.ts$/, "")}.regression.test.ts`,
        seen: {
          seed: o.seed,
          maxRuns: o.maxRuns,
          noRegression: o.noRegression,
          provers: o.provers,
        },
      })}\n`,
    );
    return 1;
  },
  report: async (o) => {
    o.stdout(
      `${JSON.stringify({
        schemaVersion: 1,
        specs: [{ module: "./domain.ts", function: "f", property: "p", kind: "TESTED" }],
        seen: { dir: o.dir, provers: o.provers, goals: o.goals, only: o.only },
        ...(o.goals
          ? {
              goals: [
                {
                  module: "./domain.ts",
                  file: "domain.props.goals.lean",
                  function: "f",
                  property: "q",
                  statement: "s",
                  reason: "r",
                },
              ],
            }
          : {}),
      })}\n`,
    );
    return 0;
  },
  status: async () => ({ engines: [{ name: "lean", installed: true, version: "4.35.0" }] }),
};
const ctx: McpContext = { cwd: "/work", log: () => {}, runners };
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
};
const send = async (message: unknown): Promise<Record<string, unknown> | undefined> => {
  const out = await handleLine(
    typeof message === "string" ? message : JSON.stringify(message),
    ctx,
  );
  return out === undefined ? undefined : (JSON.parse(out) as Record<string, unknown>);
};
const modern = (id: number, method: string, params: Record<string, unknown> = {}) =>
  send({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
const legacy = (id: number, method: string, params: Record<string, unknown> = {}) =>
  send({ jsonrpc: "2.0", id, method, params });

describe("the stateless era (2026-07-28)", () => {
  test("server/discover answers the versions served, with the server's identity in _meta", async () => {
    const r = await modern(1, "server/discover");
    expect(r).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: [...modernVersions],
        capabilities: { tools: {} },
        instructions: expect.stringContaining("`check` runs a scenario"),
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      },
    });
  });

  test("an unsupported version is -32022 with the supported list; missing client capabilities is -32602", async () => {
    const r = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2027-01-01" } },
    });
    expect(r?.["error"]).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28"], requested: "2027-01-01" },
    });
    const bare = await send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(((bare?.["error"] ?? {}) as { code: number }).code).toBe(-32602);
  });

  test("tools/list names the five tools in a fixed order, each with a JSON Schema; tools/call returns the report as structured content and text", async () => {
    const list = (await modern(4, "tools/list"))?.["result"] as {
      tools: { name: string; inputSchema: { type: string } }[];
    };
    expect(list.tools.map((t) => t.name)).toEqual([
      "check",
      "report",
      "goals",
      "prove",
      "prover_status",
    ]);
    expect(list.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    const call = (
      await modern(5, "tools/call", {
        name: "check",
        arguments: {
          scenario: "orders.sim.ts",
          seed: "s",
          maxRuns: 7,
          regression: false,
          provers: ["smt"],
        },
      })
    )?.["result"] as Record<string, unknown>;
    expect(call["resultType"]).toBe("complete");
    expect(call["isError"]).toBe(false);
    const structured = call["structuredContent"] as {
      exitCode: number;
      report: Record<string, unknown>;
    };
    expect(structured.exitCode).toBe(1);
    expect(structured.report["regressionTest"]).toBe("orders.regression.test.ts");
    expect(structured.report["seen"]).toEqual({
      seed: "s",
      maxRuns: 7,
      noRegression: true,
      provers: ["smt"],
    });
    const content = call["content"] as { type: string; text: string }[];
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toEqual(structured);
  });
});

describe("the handshake era (2025-11-25 and before)", () => {
  test("initialize echoes a served version, or answers the latest served; results carry no resultType", async () => {
    const r = (
      await legacy(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      })
    )?.["result"] as Record<string, unknown>;
    expect(r["protocolVersion"]).toBe("2025-06-18");
    expect(r["capabilities"]).toEqual({ tools: {} });
    expect(r["serverInfo"]).toEqual(serverInfo);
    expect(r["resultType"]).toBeUndefined();
    const old = (await legacy(2, "initialize", { protocolVersion: "2020-01-01" }))?.[
      "result"
    ] as Record<string, unknown>;
    expect(old["protocolVersion"]).toBe(legacyVersions[0]);
    expect(await send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await legacy(3, "ping")).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  test("the tools answer the same; goals and prove run the report with the lean engine", async () => {
    const goals = (await legacy(4, "tools/call", { name: "goals", arguments: { dir: "src" } }))?.[
      "result"
    ] as Record<string, unknown>;
    const structured = goals["structuredContent"] as { report: Record<string, unknown> };
    expect(structured.report["seen"]).toEqual({ dir: "src", provers: ["lean"], goals: true });
    expect((structured.report["goals"] as unknown[]).length).toBe(1);
    const prove = (
      await legacy(5, "tools/call", { name: "prove", arguments: { spec: "src/domain.props.ts" } })
    )?.["result"] as Record<string, unknown>;
    expect(
      (prove["structuredContent"] as { report: Record<string, unknown> }).report["seen"],
    ).toEqual({
      dir: "src",
      provers: ["lean"],
      only: "src/domain.props.ts",
    });
    const status = (await legacy(6, "tools/call", { name: "prover_status" }))?.["result"] as Record<
      string,
      unknown
    >;
    expect(status["structuredContent"]).toEqual({
      engines: [{ name: "lean", installed: true, version: "4.35.0" }],
    });
  });
});

describe("errors", () => {
  test("protocol errors: parse, batch, bad request, unknown method, unknown tool", async () => {
    expect(await send("{not json")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect((await send([{ jsonrpc: "2.0", id: 1, method: "ping" }]))?.["error"]).toMatchObject({
      code: -32600,
    });
    expect((await send({ jsonrpc: "1.0", id: 1, method: "ping" }))?.["error"]).toMatchObject({
      code: -32600,
    });
    expect((await send({ jsonrpc: "2.0", id: null, method: "ping" }))?.["error"]).toMatchObject({
      code: -32600,
    });
    expect((await legacy(7, "resources/list"))?.["error"]).toEqual({
      code: -32601,
      message: "Method not found: resources/list",
    });
    expect((await legacy(8, "tools/call", { name: "nope" }))?.["error"]).toEqual({
      code: -32602,
      message: "Unknown tool: nope",
    });
    expect(
      (await legacy(9, "tools/call", { name: "check", arguments: [] }))?.["error"],
    ).toMatchObject({ code: -32602 });
  });

  test("tool errors: bad arguments, and a command that could not run, come back as isError results", async () => {
    const missing = (await legacy(10, "tools/call", { name: "check", arguments: {} }))?.[
      "result"
    ] as Record<string, unknown>;
    expect(missing["isError"]).toBe(true);
    expect((missing["content"] as { text: string }[])[0]?.text).toBe("scenario is required");
    const extra = (
      await legacy(11, "tools/call", { name: "report", arguments: { dir: "x", nope: 1 } })
    )?.["result"] as Record<string, unknown>;
    expect((extra["content"] as { text: string }[])[0]?.text).toMatch(/^unknown argument nope/);
    const bad = (
      await legacy(12, "tools/call", {
        name: "check",
        arguments: { scenario: "s.sim.ts", maxRuns: 0 },
      })
    )?.["result"] as Record<string, unknown>;
    expect((bad["content"] as { text: string }[])[0]?.text).toBe(
      "maxRuns must be a positive integer",
    );
    const failing: McpContext = {
      ...ctx,
      runners: {
        ...runners,
        check: async (o) => {
          o.stderr("scenario not found: s.sim.ts\n");
          return 3;
        },
      },
    };
    const out = JSON.parse(
      (await handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "check", arguments: { scenario: "s.sim.ts" } },
        }),
        failing,
      )) as string,
    ) as Record<string, unknown>;
    const result = out["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    expect((result["content"] as { text: string }[])[0]?.text).toBe(
      "check could not run (exit 3): scenario not found: s.sim.ts",
    );
  });

  test("every tool's schema forbids unknown properties, and the names are MCP tool names", () => {
    for (const t of tools) {
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
      expect(t.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });
});
