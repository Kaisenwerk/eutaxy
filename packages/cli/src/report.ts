/**
 * `eutaxy report [dir]`: every spec file under a directory through the
 * ladder, on the Node side. No scenario runs, so the ladder starts at
 * `TESTED` (inputs drawn from the parameter types); `--prover` adds the
 * `PROVEN` rung. Each module runs in a worker thread of its own, started
 * on this file: what the module prints goes to stderr, its state starts
 * fresh, and a property that never returns ends with the module's budget.
 * A module that only loads inside workerd gets `UNKNOWN` until an engine
 * reads it.
 */

import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { SpecVerdict } from "@eutaxy/core";
import { checkSpecModule, type Prover } from "@eutaxy/prover";
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
  readonly json: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface WorkerInput {
  readonly kind: "eutaxy-report-module";
  readonly module: SpecModule;
  readonly seed: string;
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
 * Inside the worker: a relative import from a `.ts` file that Node cannot
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

/** Inside the worker: load the module and its spec file, run the `TESTED` rung. */
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

const input = isMainThread ? undefined : (workerData as Partial<WorkerInput> | null);
if (input?.kind === "eutaxy-report-module" && input.module && input.seed !== undefined)
  parentPort?.postMessage(await testHere(input.module, input.seed));

/**
 * One module's verdicts at the `TESTED` rung, from a worker thread. What
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
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: "eutaxy-report-module", module: m, seed } satisfies WorkerInput,
      stdout: true,
      stderr: true,
    });
    worker.stdout.on("data", (d: Buffer) => stderr(d.toString()));
    worker.stderr.on("data", (d: Buffer) => stderr(d.toString()));
    let settled = false;
    const finish = (verdicts: SpecVerdict[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      done(verdicts);
    };
    const timer = setTimeout(
      () =>
        finish(
          unknownAll(
            m,
            "gave_up",
            `the module's properties did not finish within ${budgetMs} ms on generated inputs (one may never return)`,
          ),
        ),
      budgetMs,
    );
    worker.once("message", (verdicts: SpecVerdict[]) => finish(verdicts));
    worker.once("error", (err) =>
      finish(unknownAll(m, "unavailable", `the module's worker failed: ${err.message}`)),
    );
    worker.once("exit", (code) =>
      finish(unknownAll(m, "unavailable", `the module's worker exited (${code}) before reporting`)),
    );
  });
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
  if (modules.length === 0) {
    o.stderr(`no spec files (*.props.ts) under ${root}\n`);
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
  if (engines.length > 0)
    specs = await proveSpecs(
      root,
      modules.map((m) => ({ module: m.key, functions: m.specs.functions.map((f) => f.name) })),
      specs,
      engines,
      modules,
    );
  o.stdout(`${o.json ? renderSpecReportJson(specs) : renderSpecReport(specs)}\n`);
  // The codes check uses: 1 for a refuted or conflicting spec, 0 otherwise; UNKNOWN fails nothing.
  return specs.some((v) => v.kind === "REFUTED" || v.kind === "CONFLICT")
    ? exitCodes.VIOLATED
    : exitCodes.BOUNDED;
}
