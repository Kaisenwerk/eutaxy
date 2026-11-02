/**
 * `eutaxy report [dir]`: every spec file under a directory through the
 * ladder, on the Node side. No scenario runs, so the ladder starts at
 * `TESTED` (inputs drawn from the parameter types); `--prover` adds the
 * `PROVEN` rung. Each module runs in a child process of its own, started
 * on this file: what the module prints goes to stderr, its state starts
 * fresh, and a property that never returns ends with the module's budget.
 * A process, not a worker thread: Node strips types with WebAssembly, and
 * V8 shares compiled wasm code between the threads of a process; V8 on
 * Node 24 can abort while one thread frees that code as another uses it
 * (seen as SIGSEGV, SIGBUS or SIGTRAP of the whole process).
 * A module that only loads inside workerd gets `UNKNOWN` until an engine
 * reads it.
 */

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, type JsonValue, type SpecVerdict } from "@eutaxy/core";
import { checkSpecModule, type OpenGoal, type Prover } from "@eutaxy/prover";
import { goalFileFor, leanProver, renderGoals } from "@eutaxy/prover-lean";
import { renderSpecReport, renderSpecReportJson } from "@eutaxy/report";
import { enginesNamed, exitCodes, proveSpecs } from "./check.ts";
import { findSpecModules, type SpecModule } from "./specs.ts";

export interface ReportOptions {
  /** The directory to search for spec files, relative to `cwd`; default `cwd` itself. */
  readonly dir?: string;
  readonly cwd: string;
  /** The seed the `TESTED` rung draws from; default "report". */
  readonly seed?: string;
  /** Engines to run the `PROVEN` rung with, by name. */
  readonly provers?: readonly string[];
  /** How long one module's properties may take at `TESTED`; default 60 s. */
  readonly moduleBudgetMs?: number;
  /** Only the module whose spec file this is (a path, relative to `cwd`), for a proof checked on its own. */
  readonly only?: string;
  /** Write each module's open Lean goals beside its spec file (`<spec>.goals.lean`) and list them. */
  readonly goals?: boolean;
  readonly json: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The argument a module's process is started with, so this file knows to run it. */
const moduleFlag = "--eutaxy-report-module";

interface ModuleInput {
  readonly module: SpecModule;
  readonly seed: string;
}

/** What a module's process sends back; tagged, since the module itself may call `process.send`. */
interface ModuleOutput {
  readonly kind: "eutaxy-report-verdicts";
  readonly verdicts: SpecVerdict[];
}

function unknownAll(
  m: SpecModule,
  cause: "gave_up" | "unavailable",
  reason: string,
): SpecVerdict[] {
  return m.specs.functions.flatMap((fn) =>
    fn.properties.map(
      (p): SpecVerdict => ({
        module: m.key,
        function: fn.name,
        property: p.name,
        text: p.text,
        kind: "UNKNOWN",
        cause,
        reason,
        assumptions: [],
      }),
    ),
  );
}

/**
 * Inside the module's process: a relative import from a `.ts` file that Node cannot
 * resolve is tried as TypeScript resolves it, so `./domain.js` and
 * `./domain` find `domain.ts` (or `domain/index.ts`), as `tsc` would.
 */
function resolveAsTypeScript(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !context.parentURL?.endsWith(".ts")) throw err;
        const stem = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
        for (const candidate of [`${stem}.ts`, `${stem}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {}
        }
        throw err;
      }
    },
  });
}

/** Inside the module's process: load the module and its spec file, run the `TESTED` rung. */
async function testHere(m: SpecModule, seed: string): Promise<SpecVerdict[]> {
  resolveAsTypeScript();
  let namespace: Readonly<Record<string, unknown>>;
  let props: Readonly<Record<string, unknown>>;
  try {
    namespace = (await import(pathToFileURL(m.path).href)) as Record<string, unknown>;
    props = (await import(pathToFileURL(m.specPath).href)) as Record<string, unknown>;
  } catch (err) {
    return unknownAll(
      m,
      "unavailable",
      `the module or its spec file did not load in Node: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return checkSpecModule(
    m.key,
    m.specs,
    props,
    namespace,
    { calls: [], unobservable: {} },
    { checked: false, tested: { seed } },
  );
}

const send = process.send?.bind(process);
if (process.argv[2] === moduleFlag && send) {
  process.once("disconnect", () => process.exit(0));
  process.once("message", async (input: ModuleInput) => {
    const verdicts = await testHere(input.module, input.seed);
    // Exit once the verdicts and everything the module wrote are out, whatever timers it left.
    send({ kind: "eutaxy-report-verdicts", verdicts } satisfies ModuleOutput, () =>
      process.stdout.write("", () => process.stderr.write("", () => process.exit(0))),
    );
  });
}

/**
 * One module's verdicts at the `TESTED` rung, from a child process. What
 * the module writes goes to `stderr`; a module that does not load, or does
 * not finish within the budget, leaves each property `UNKNOWN`.
 */
export function testModule(
  m: SpecModule,
  seed: string,
  budgetMs: number,
  stderr: (text: string) => void,
): Promise<SpecVerdict[]> {
  return new Promise((done) => {
    const child = fork(fileURLToPath(import.meta.url), [moduleFlag], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    child.stdout?.on("data", (d: Buffer) => stderr(d.toString()));
    child.stderr?.on("data", (d: Buffer) => stderr(d.toString()));
    // Settled on `close`, once the process has exited and all it wrote is read; `reported` holds
    // its verdicts if it sent them, and `ended` why it stopped otherwise.
    let reported: SpecVerdict[] | undefined;
    let ended: SpecVerdict[] | undefined;
    let settled = false;
    const settle = (verdicts: SpecVerdict[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(verdicts);
    };
    const timer = setTimeout(() => {
      ended = unknownAll(
        m,
        "gave_up",
        `the module's properties did not finish within ${budgetMs} ms on generated inputs (one may never return)`,
      );
      child.kill("SIGKILL");
      // A process the module started may still hold the pipes open.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, budgetMs);
    child.on("message", (message: Partial<ModuleOutput> | null) => {
      if (message?.kind === "eutaxy-report-verdicts" && Array.isArray(message.verdicts))
        reported ??= message.verdicts;
    });
    child.once("error", (err) => {
      ended ??= unknownAll(m, "unavailable", `the module's process failed: ${err.message}`);
      // A process that never started (no pid) emits no `close`.
      if (child.pid === undefined) settle(ended);
      else child.kill("SIGKILL");
    });
    child.once("close", (code, signal) => {
      settle(
        reported ??
          ended ??
          unknownAll(
            m,
            "unavailable",
            `the module's process exited (${signal ?? code}) before reporting`,
          ),
      );
    });
    child.send({ module: m, seed } satisfies ModuleInput);
  });
}

/** One open goal as the report lists it: where its goal file is, and the goal itself. */
export interface WrittenGoal extends OpenGoal {
  readonly module: string;
  /** The goal file, relative to the working directory. */
  readonly file: string;
}

/**
 * Write a module's open Lean goals beside its spec file as
 * `<spec>.goals.lean`, a proof file with every proof open, and list them.
 * No open goal removes a goal file left from an earlier run.
 */
function writeGoals(m: SpecModule, goals: readonly OpenGoal[], cwd: string): WrittenGoal[] {
  const path = goalFileFor(m.specPath);
  if (goals.length === 0) {
    rmSync(path, { force: true });
    return [];
  }
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  writeFileSync(
    path,
    renderGoals({
      specFile: basename(m.specPath),
      sourceSha256: sha(readFileSync(m.path, "utf8")),
      specSha256: sha(readFileSync(m.specPath, "utf8")),
      goals,
    }),
  );
  const file = relative(cwd, path).split("\\").join("/");
  return goals.map((g) => ({ module: m.key, file, ...g }));
}

export async function runReport(o: ReportOptions): Promise<number> {
  const root = resolve(o.cwd, o.dir ?? ".");
  let engines: Prover[] = [];
  if (o.provers && o.provers.length > 0) {
    const named = enginesNamed(o.provers);
    if ("error" in named) {
      o.stderr(`${named.error}\n`);
      return exitCodes.error;
    }
    engines = named.engines;
  }
  let modules: SpecModule[];
  try {
    modules = findSpecModules(root);
  } catch (err) {
    o.stderr(`cannot read ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
    return exitCodes.error;
  }
  if (o.only !== undefined) {
    const spec = resolve(o.cwd, o.only);
    modules = modules.filter((m) => m.specPath === spec);
    if (modules.length === 0) {
      o.stderr(`no spec file ${spec} under ${root}\n`);
      return exitCodes.error;
    }
  }
  if (modules.length === 0) {
    o.stderr(`no spec files (*.props.ts) under ${root}\n`);
    return exitCodes.error;
  }
  if (o.goals && !engines.some((e) => e.name === leanProver.name)) {
    o.stderr("--goals needs the lean engine among --prover\n");
    return exitCodes.error;
  }
  const errors = modules.flatMap((m) =>
    m.specs.errors.map((e) => `${m.key}${e.line > 0 ? `:${e.line}` : ""}: ${e.message}`),
  );
  if (errors.length > 0) {
    for (const e of errors) o.stderr(`${e}\n`);
    return exitCodes.error;
  }
  let specs: readonly SpecVerdict[] = [];
  for (const m of modules)
    specs = [
      ...specs,
      ...(await testModule(m, o.seed ?? "report", o.moduleBudgetMs ?? 60_000, o.stderr)),
    ];
  const goals: WrittenGoal[] = [];
  if (engines.length > 0)
    specs = await proveSpecs(
      root,
      modules.map((m) => ({ module: m.key, functions: m.specs.functions.map((f) => f.name) })),
      specs,
      engines,
      modules,
      o.goals
        ? (m, report) => {
            if (report.engine !== leanProver.name) return;
            // An engine that did not answer (not installed, timed out, or the emitted Lean did not
            // compile) lists no goals; a goal file left from an earlier run stands until it answers.
            if (report.proofs.goals === undefined) return;
            goals.push(...writeGoals(m, report.proofs.goals, o.cwd));
          }
        : undefined,
    );
  if (o.json) {
    const json = JSON.parse(renderSpecReportJson(specs)) as Record<string, unknown>;
    o.stdout(
      `${canonicalJson({ ...json, ...(o.goals ? { goals } : {}) } as unknown as JsonValue)}\n`,
    );
  } else {
    o.stdout(`${renderSpecReport(specs)}\n`);
    if (o.goals)
      o.stdout(
        goals.length === 0
          ? "\nNo open Lean goals.\n"
          : `\n${goals.length} open Lean goal${goals.length === 1 ? "" : "s"} written to ${[...new Set(goals.map((g) => g.file))].join(", ")}\n`,
      );
  }
  // The codes check uses: 1 for a refuted or conflicting spec, 0 otherwise; UNKNOWN fails nothing.
  return specs.some((v) => v.kind === "REFUTED" || v.kind === "CONFLICT")
    ? exitCodes.VIOLATED
    : exitCodes.BOUNDED;
}
