/**
 * `eutaxy mcp`: a Model Context Protocol server over stdio, so a coding
 * agent runs the loop "check, read the report, fix or prove, check again"
 * through one tool. One JSON-RPC message per line on stdin and stdout,
 * logs on stderr, exit when stdin closes; written with the standard
 * library alone. It speaks both eras of the protocol: the stateless
 * `2026-07-28` revision, every request carrying its version and client
 * capabilities in `_meta` and `server/discover` answering what is
 * supported; and the `2025-11-25` revision (and its predecessors) with the
 * `initialize` handshake today's clients open with. The tools are pure
 * functions of the repository's files that return the JSON report, as
 * structured content beside its text; a verdict is a result whatever it
 * says, and only a command that could not run is a tool error. Eutaxy
 * never calls a model: every verdict depends only on files.
 */

import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { type CheckOptions, exitCodes, provers, runCheck } from "./check.ts";
import { runDraft } from "./draft.ts";
import { type ReportOptions, runReport } from "./report.ts";
import { eutaxyVersion } from "./version.ts";

/** The protocol revisions served: the stateless one by `_meta`, the handshake ones by `initialize`. */
export const modernVersions: readonly string[] = ["2026-07-28"];
export const legacyVersions: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const protocolVersionKey = "io.modelcontextprotocol/protocolVersion";
const clientCapabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const serverInfoKey = "io.modelcontextprotocol/serverInfo";

export const serverInfo = { name: "eutaxy", version: eutaxyVersion } as const;

export const instructions = [
  "Eutaxy checks Cloudflare Workers by deterministic simulation and proves properties of their pure TypeScript core.",
  "`check` runs a scenario file (*.sim.ts) and returns the verdict: BOUNDED (no violation within the bounds), VIOLATED (with the shrunk schedule, and a regression test written beside the scenario that replays it), or UNSUPPORTED.",
  "`report` runs every spec file (*.props.ts) under a directory through the TESTED rung and, with engines named, the PROVEN rung.",
  "`goals` lists the properties the Lean engine could not prove and writes each module's open goals beside its spec file as <spec>.goals.lean, a proof file with every proof open: copy it to <spec>.lean, add lemmas and tactics, then call `prove` on the spec file. A proof whose source or spec changed since the goals were written is stale, never PROVEN.",
  "`prover_status` says which proof engines are installed; `eutaxy prover install lean` or `smt` installs one.",
  "Verdicts depend only on files in the repository; nothing here calls a model.",
].join("\n");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Params = Record<string, unknown>;

interface Request {
  readonly id: string | number;
  readonly method: string;
  readonly params: Params;
  /** The `_meta` the request carries, when it is of the stateless era. */
  readonly modern: boolean;
}

/** What a tool answers: structured content, its text form, and whether the tool itself failed. */
export interface ToolResult {
  readonly structured: Json;
  readonly text: string;
  readonly isError?: boolean;
}

/** The commands the tools run, injectable for tests; the real ones otherwise. */
export interface Runners {
  readonly check: (o: CheckOptions) => Promise<number>;
  readonly report: (o: ReportOptions) => Promise<number>;
  readonly status: () => Promise<Json>;
}

export interface McpContext {
  readonly cwd: string;
  /** Where logs go: stderr. */
  readonly log: (text: string) => void;
  readonly runners?: Partial<Runners>;
}

const realRunners: Runners = {
  check: runCheck,
  report: runReport,
  status: async () => {
    const engines: Json[] = [];
    for (const [name, engine] of Object.entries(provers)) {
      const a = await engine.available();
      engines.push({
        name,
        ...("unavailable" in a
          ? { installed: false, reason: a.unavailable }
          : { installed: true, version: a.version }),
      });
    }
    return { engines };
  },
};

class ToolError extends Error {}

/** A command's exit code and what it printed. */
async function capture(
  run: (stdout: (t: string) => void, stderr: (t: string) => void) => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(
    (t) => {
      stdout += t;
    },
    (t) => {
      stderr += t;
    },
  );
  return { code, stdout, stderr };
}

/** The report a command printed as JSON, or a tool error with what it said instead. */
function reported(what: string, r: { code: number; stdout: string; stderr: string }): Json {
  if (r.code === exitCodes.error)
    throw new ToolError(`${what} could not run (exit 3): ${r.stderr.trim() || r.stdout.trim()}`);
  try {
    return JSON.parse(r.stdout) as Json;
  } catch {
    throw new ToolError(`${what} printed no JSON report: ${(r.stdout + r.stderr).trim()}`);
  }
}

const str = (args: Params, key: string, required = false): string | undefined => {
  const v = args[key];
  if (v === undefined) {
    if (required) throw new ToolError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length === 0)
    throw new ToolError(`${key} must be a non-empty string`);
  return v;
};
const bool = (args: Params, key: string): boolean | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be a boolean`);
  return v;
};
const positiveInt = (args: Params, key: string): number | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw new ToolError(`${key} must be a positive integer`);
  return v;
};
const strings = (args: Params, key: string): string[] | undefined => {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0))
    throw new ToolError(`${key} must be an array of non-empty strings`);
  return v as string[];
};
const only = (args: Params, allowed: readonly string[]): void => {
  const extra = Object.keys(args).find((k) => !allowed.includes(k));
  if (extra !== undefined)
    throw new ToolError(`unknown argument ${extra}; the arguments are ${allowed.join(", ")}`);
};

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly run: (args: Params, ctx: McpContext, runners: Runners) => Promise<ToolResult>;
}

const engineNames = Object.keys(provers);
const proversSchema: Json = {
  type: "array",
  items: { type: "string", enum: engineNames },
  description: `Proof engines for the PROVEN rung: ${engineNames.join(", ")}`,
};

const asResult = (structured: Json, isError = false): ToolResult => ({
  structured,
  text: JSON.stringify(structured, null, 2),
  ...(isError ? { isError: true } : {}),
});

export const tools: readonly Tool[] = [
  {
    name: "check",
    title: "Check a scenario",
    description:
      "Run a scenario file (*.sim.ts) in the simulator and return the JSON report: the verdict (BOUNDED, VIOLATED with the shrunk schedule, or UNSUPPORTED), the spec verdicts, and on a violation the path of the regression test written beside the scenario (regressionTest). Exit code 1 is a violation or a refuted spec, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        scenario: {
          type: "string",
          description: "Path of the scenario file, relative to the working directory",
        },
        wrangler: {
          type: "string",
          description:
            "Wrangler config path; default: the one the scenario names, else the one beside it",
        },
        seed: { type: "string", description: "Exploration seed; default: the scenario file name" },
        maxRuns: { type: "integer", minimum: 1, description: "Cap on exploration runs" },
        budgetMs: {
          type: "integer",
          minimum: 1,
          description: "Time budget in milliseconds, replacing the scenario's",
        },
        exhaustive: { type: "boolean", description: "Run every schedule within the bounds once" },
        provers: proversSchema,
        regression: {
          type: "boolean",
          description: "Write the regression test on a violation; default true",
        },
        out: { type: "string", description: "Where to write the regression test" },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
    async run(args, ctx, runners) {
      only(args, [
        "scenario",
        "wrangler",
        "seed",
        "maxRuns",
        "budgetMs",
        "exhaustive",
        "provers",
        "regression",
        "out",
      ]);
      const scenario = str(args, "scenario", true) as string;
      const wrangler = str(args, "wrangler");
      const seed = str(args, "seed");
      const maxRuns = positiveInt(args, "maxRuns");
      const budgetMs = positiveInt(args, "budgetMs");
      const engines = strings(args, "provers");
      const out = str(args, "out");
      const r = await capture((stdout, stderr) =>
        runners.check({
          scenario,
          cwd: ctx.cwd,
          ...(wrangler === undefined ? {} : { wrangler }),
          ...(seed === undefined ? {} : { seed }),
          ...(maxRuns === undefined ? {} : { maxRuns }),
          ...(budgetMs === undefined ? {} : { budgetMs }),
          exhaustive: bool(args, "exhaustive") === true,
          ...(engines === undefined ? {} : { provers: engines }),
          json: true,
          ...(out === undefined ? {} : { out }),
          noRegression: bool(args, "regression") === false,
          expectViolation: false,
          keep: false,
          stdout,
          stderr,
        }),
      );
      return asResult({ exitCode: r.code, report: reported("check", r) });
    },
  },
  {
    name: "report",
    title: "Report on the spec files",
    description:
      "Run every spec file (*.props.ts) under a directory through the TESTED rung and, with engines named, the PROVEN rung; return the JSON report of spec verdicts. Exit code 1 is a refuted or conflicting spec, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Directory to search; default: the working directory" },
        provers: proversSchema,
        seed: { type: "string", description: "Seed for the TESTED rung; default report" },
      },
      additionalProperties: false,
    },
    async run(args, ctx, runners) {
      only(args, ["dir", "provers", "seed"]);
      const dir = str(args, "dir");
      const engines = strings(args, "provers");
      const seed = str(args, "seed");
      const r = await capture((stdout, stderr) =>
        runners.report({
          cwd: ctx.cwd,
          ...(dir === undefined ? {} : { dir }),
          ...(engines === undefined ? {} : { provers: engines }),
          ...(seed === undefined ? {} : { seed }),
          json: true,
          stdout,
          stderr,
        }),
      );
      return asResult({ exitCode: r.code, report: reported("report", r) });
    },
  },
  {
    name: "goals",
    title: "List the open proof goals",
    description:
      "Run the Lean engine on every spec file under a directory and list the properties it could not prove, each with the statement it tried; write each module's open goals beside its spec file as <spec>.goals.lean, a proof file with every proof open (copy it to <spec>.lean, add lemmas and tactics, then call prove). Needs the lean engine installed.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Directory to search; default: the working directory" },
      },
      additionalProperties: false,
    },
    async run(args, ctx, runners) {
      only(args, ["dir"]);
      const dir = str(args, "dir");
      const r = await capture((stdout, stderr) =>
        runners.report({
          cwd: ctx.cwd,
          ...(dir === undefined ? {} : { dir }),
          provers: ["lean"],
          goals: true,
          json: true,
          stdout,
          stderr,
        }),
      );
      return asResult({ exitCode: r.code, report: reported("goals", r) });
    },
  },
  {
    name: "prove",
    title: "Check the proofs supplied for a spec file",
    description:
      "Run the Lean engine on one module, the one whose spec file (*.props.ts) is given, with the proofs supplied beside it in <spec>.lean, and return its spec verdicts: PROVEN where a proof closes (Lean's kernel checked it against the statement Eutaxy emitted), UNKNOWN with the reason where it does not, or where the proof file is stale (written for another version of the module or the spec).",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "string",
          description: "Path of the spec file, relative to the working directory",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    async run(args, ctx, runners) {
      only(args, ["spec"]);
      const spec = str(args, "spec", true) as string;
      const r = await capture((stdout, stderr) =>
        runners.report({
          cwd: ctx.cwd,
          dir: dirname(spec),
          only: spec,
          provers: ["lean"],
          json: true,
          stdout,
          stderr,
        }),
      );
      return asResult({ exitCode: r.code, report: reported("prove", r) });
    },
  },
  {
    name: "draft",
    title: "Draft a scenario",
    description:
      "Draft a scenario (*.sim.ts) from a wrangler config (JSON or JSONC) and the Worker module it names: the bindings become setup steps (a service binding whose Worker's config is found under the directory becomes a callee), the Worker's handlers the drive, the hosts its code fetches the externals; the invariants and the drive's events are holes marked TODO for you to fill before calling check. Returns the source, the draft as data and its notes (bindings not modelled, guesses made); with out, also writes the file, never over an existing one. Nothing is imported or run.",
    inputSchema: {
      type: "object",
      properties: {
        config: {
          type: "string",
          description:
            "Wrangler config path, relative to the working directory; default: wrangler.jsonc or wrangler.json there",
        },
        worker: {
          type: "string",
          description: "The Worker module; default: the config's main",
        },
        out: {
          type: "string",
          description:
            "Where to write the scenario; paths in it are relative to its directory. Default: not written",
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      only(args, ["config", "worker", "out"]);
      const config = str(args, "config");
      const worker = str(args, "worker");
      const out = str(args, "out");
      let stdout = "";
      let stderr = "";
      const code = runDraft({
        cwd: ctx.cwd,
        ...(config === undefined ? {} : { config }),
        ...(worker === undefined ? {} : { worker }),
        ...(out === undefined ? {} : { out }),
        json: true,
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
      });
      if (code !== 0) throw new ToolError(stderr.trim() || `draft exited ${code}`);
      return asResult(JSON.parse(stdout) as Json);
    },
  },
  {
    name: "prover_status",
    title: "Which proof engines are installed",
    description:
      "For each proof engine (lean, smt): whether its pinned toolchain is installed and its version, or why not and how to install it (eutaxy prover install <name>).",
    inputSchema: { type: "object", additionalProperties: false },
    async run(args, _ctx, runners) {
      only(args, []);
      return asResult(await runners.status());
    },
  },
];

interface Response {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: Json;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: Json };
}

const errorResponse = (
  id: string | number | null,
  code: number,
  message: string,
  data?: Json,
): Response => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** A result in the requester's era: the stateless one carries `resultType` and the server's identity. */
const resultResponse = (req: Request, result: { [key: string]: Json }): Response => ({
  jsonrpc: "2.0",
  id: req.id,
  result: req.modern
    ? { resultType: "complete", ...result, _meta: { [serverInfoKey]: serverInfo } }
    : result,
});

const toolListing = (): Json =>
  tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

async function callTool(req: Request, ctx: McpContext): Promise<Response> {
  const name = req.params["name"];
  const tool = tools.find((t) => t.name === name);
  if (typeof name !== "string" || !tool)
    return errorResponse(req.id, -32602, `Unknown tool: ${String(name)}`);
  const args = req.params["arguments"] ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return errorResponse(req.id, -32602, "arguments must be an object");
  const runners: Runners = { ...realRunners, ...ctx.runners };
  let result: ToolResult;
  try {
    result = await tool.run(args as Params, ctx, runners);
  } catch (err) {
    // The tool itself failed: an execution error the model can act on, not a protocol error.
    const message = err instanceof Error ? err.message : String(err);
    result = { structured: { error: message }, text: message, isError: true };
  }
  return resultResponse(req, {
    content: [{ type: "text", text: result.text }],
    structuredContent: result.structured,
    isError: result.isError === true,
  });
}

/**
 * One line in, at most one line out: the response to a request, nothing
 * for a notification. A request of the stateless era whose version is not
 * served gets the `UnsupportedProtocolVersion` error with what is.
 */
export async function handleLine(line: string, ctx: McpContext): Promise<string | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return JSON.stringify(errorResponse(null, -32700, "Parse error"));
  }
  if (Array.isArray(message))
    return JSON.stringify(
      errorResponse(null, -32600, "Invalid Request: batches are not supported"),
    );
  if (typeof message !== "object" || message === null)
    return JSON.stringify(errorResponse(null, -32600, "Invalid Request"));
  const m = message as Record<string, unknown>;
  const id = m["id"];
  const idOk = typeof id === "string" || typeof id === "number";
  if (m["jsonrpc"] !== "2.0" || typeof m["method"] !== "string")
    return JSON.stringify(
      errorResponse(idOk ? (id as string | number) : null, -32600, "Invalid Request"),
    );
  if (id === undefined) return undefined; // a notification: initialized, cancelled, progress; nothing to answer
  if (!idOk)
    return JSON.stringify(
      errorResponse(null, -32600, "Invalid Request: id must be a string or a number"),
    );
  const params = (
    typeof m["params"] === "object" && m["params"] !== null ? m["params"] : {}
  ) as Params;
  const meta = (
    typeof params["_meta"] === "object" && params["_meta"] !== null ? params["_meta"] : {}
  ) as Params;
  const requested = meta[protocolVersionKey];
  const req: Request = {
    id: id as string | number,
    method: m["method"],
    params,
    modern: typeof requested === "string",
  };
  if (req.modern) {
    if (!modernVersions.includes(requested as string))
      return JSON.stringify(
        errorResponse(req.id, -32022, "Unsupported protocol version", {
          supported: [...modernVersions],
          requested: requested as string,
        }),
      );
    if (typeof meta[clientCapabilitiesKey] !== "object" || meta[clientCapabilitiesKey] === null)
      return JSON.stringify(
        errorResponse(req.id, -32602, `Invalid params: _meta.${clientCapabilitiesKey} is required`),
      );
  }
  let response: Response;
  try {
    response = await dispatch(req, ctx);
  } catch (err) {
    response = errorResponse(
      req.id,
      -32603,
      `Internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return JSON.stringify(response);
}

async function dispatch(req: Request, ctx: McpContext): Promise<Response> {
  switch (req.method) {
    case "initialize": {
      const asked = req.params["protocolVersion"];
      const version =
        typeof asked === "string" && legacyVersions.includes(asked)
          ? asked
          : (legacyVersions[0] as string);
      return resultResponse(req, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo,
        instructions,
      });
    }
    case "ping":
      return resultResponse(req, {});
    case "server/discover":
      return resultResponse(req, {
        supportedVersions: [...modernVersions],
        capabilities: { tools: {} },
        instructions,
      });
    case "tools/list":
      return resultResponse(req, { tools: toolListing() });
    case "tools/call":
      return callTool(req, ctx);
    default:
      return errorResponse(req.id, -32601, `Method not found: ${req.method}`);
  }
}

/** Serve on the process's standard streams until stdin closes. Requests are answered one at a time, in order. */
export async function serveStdio(ctx: McpContext): Promise<number> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const out = await handleLine(line, ctx);
    if (out !== undefined) process.stdout.write(`${out}\n`);
  }
  return exitCodes.BOUNDED;
}
