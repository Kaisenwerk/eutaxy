/**
 * `eutaxy check <scenario.sim.ts>`: run a scenario inside workerd through
 * the user's Vitest and the Cloudflare plugin, print the verdict as text or
 * JSON, and on a violation write a regression test next to the scenario.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  canonicalJson,
  type JsonValue,
  type ScenarioVerdict,
  type SpecVerdict,
  type Violated,
} from "@eutaxy/core";
import { aggregate, type EngineReport, type Prover } from "@eutaxy/prover";
import { leanProver } from "@eutaxy/prover-lean";
import { smtProver } from "@eutaxy/prover-smt";
import { renderSpecs, renderText } from "@eutaxy/report";
import { checkTestSource, metaKey, vitestConfigSource } from "./generate.ts";
import { cloudflareRegressionTest } from "./regression.ts";
import { findSpecModules, type SpecModule, specFiles, specKey } from "./specs.ts";
import type { CheckTransport } from "./workerd.ts";

export interface CheckOptions {
  readonly scenario: string;
  readonly cwd: string;
  readonly wrangler?: string;
  readonly seed?: string;
  readonly maxRuns?: number;
  /** Replaces the scenario's time budget. */
  readonly budgetMs?: number;
  /** Run every schedule within the bounds once instead of drawing them from the seed. */
  readonly exhaustive?: boolean;
  /** Engines to run the PROVEN rung with, by name, on the scenario's spec modules. */
  readonly provers?: readonly string[];
  readonly json: boolean;
  /** Where to write the regression test on a violation; default `<name>.regression.test.ts` beside the scenario. */
  readonly out?: string;
  readonly noRegression: boolean;
  /** Emit a regression test that asserts the violation (for corpora) rather than one that expects it fixed. */
  readonly expectViolation: boolean;
  /** Keep the generated `.eutaxy/` files for inspection. */
  readonly keep: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const exitCodes = { BOUNDED: 0, VIOLATED: 1, UNSUPPORTED: 2, error: 3 } as const;

/** The engines `--prover` can name. */
export const provers: Readonly<Record<string, Prover>> = { lean: leanProver, smt: smtProver };

/** The engines named, or the error naming the first unknown one. */
export function enginesNamed(
  names: readonly string[],
): { readonly engines: Prover[] } | { readonly error: string } {
  const engines: Prover[] = [];
  for (const name of names) {
    const engine = provers[name];
    if (!engine)
      return { error: `unknown prover ${name}; known: ${Object.keys(provers).join(", ")}` };
    engines.push(engine);
  }
  return { engines };
}

/**
 * The PROVEN rung, on the Node side: each engine on each observed spec
 * module's source, the outcomes folded into the simulator's verdicts.
 * An engine that is not installed proves nothing and says so.
 */
export async function proveSpecs(
  dir: string,
  observed: readonly { readonly module: string; readonly functions: readonly string[] }[],
  specs: readonly SpecVerdict[],
  engines: readonly Prover[],
  modules: readonly SpecModule[] = findSpecModules(dir),
): Promise<readonly SpecVerdict[]> {
  let out = specs;
  for (const m of observed) {
    // Verdicts carry the module as a normalized key ("./domain.ts"); the observed path is as the scenario wrote it.
    const key = specKey(m.module);
    const found = modules.find((s) => s.key === key);
    const withSpecs = m.functions.filter((f) =>
      specs.some((v) => v.module === key && v.function === f),
    );
    if (!found || withSpecs.length === 0) continue;
    const source = readFileSync(found.path, "utf8");
    const reports: EngineReport[] = [];
    for (const engine of engines)
      reports.push({
        engine: engine.name,
        proofs: await engine.prove({
          source,
          specs: found.specs,
          functions: withSpecs,
          specPath: found.specPath,
        }),
      });
    out = aggregate(key, out, reports);
  }
  return out;
}

function findWrangler(dir: string, explicit: string | undefined, cwd: string): string | null {
  if (explicit) return resolve(cwd, explicit);
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function vitestBin(from: string): string {
  const req = createRequire(join(from, "package.json"));
  return join(dirname(req.resolve("vitest/package.json")), "vitest.mjs");
}

function runVitest(
  bin: string,
  configPath: string,
  cwd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, "run", "--config", configPath], {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

/** The transport the generated test left in its task meta, via Vitest's JSON reporter. */
function readTransport(reportPath: string): CheckTransport | null {
  if (!existsSync(reportPath)) return null;
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    testResults?: { assertionResults?: { meta?: Record<string, unknown> }[] }[];
  };
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const m = t.meta?.[metaKey];
      if (m) return m as CheckTransport;
    }
  }
  return null;
}

function toPosix(p: string): string {
  const s = p.split("\\").join("/");
  return s.startsWith(".") ? s : `./${s}`;
}

export async function runCheck(o: CheckOptions): Promise<number> {
  const scenarioPath = resolve(o.cwd, o.scenario);
  if (!existsSync(scenarioPath)) {
    o.stderr(`scenario not found: ${scenarioPath}\n`);
    return exitCodes.error;
  }
  const dir = dirname(scenarioPath);
  const name = basename(scenarioPath)
    .replace(/\.sim\.ts$/, "")
    .replace(/\.ts$/, "");
  const wrangler = findWrangler(dir, o.wrangler, o.cwd);
  if (!wrangler || !existsSync(wrangler)) {
    o.stderr(`no wrangler config found next to the scenario; pass --wrangler <path>\n`);
    return exitCodes.error;
  }
  const workDir = join(dir, ".eutaxy");
  const testPath = join(workDir, `${name}.check.test.ts`);
  const configPath = join(workDir, "vitest.config.mts");
  mkdirSync(workDir, { recursive: true });
  try {
    writeFileSync(
      testPath,
      checkTestSource({
        seed: o.seed ?? name,
        ...(o.maxRuns === undefined ? {} : { maxRuns: o.maxRuns }),
        ...(o.budgetMs === undefined ? {} : { budgetMs: o.budgetMs }),
        ...(o.exhaustive ? { exhaustive: true } : {}),
        scenarioImport: `../${basename(scenarioPath)}`,
      }),
    );
    const specModules = findSpecModules(dir);
    for (const f of specFiles(specModules, workDir)) {
      mkdirSync(dirname(join(workDir, f.name)), { recursive: true });
      writeFileSync(join(workDir, f.name), f.source);
    }
    const reportPath = join(workDir, "vitest-report.json");
    rmSync(reportPath, { force: true }); // never read a report left by an earlier --keep run
    writeFileSync(configPath, vitestConfigSource(wrangler, testPath, reportPath));
    const { code, output } = await runVitest(vitestBin(dir), configPath, dir);
    const transport = code === 0 ? readTransport(reportPath) : null;
    if (!transport) {
      o.stderr(`eutaxy check could not read a verdict from Vitest (exit ${code}):\n${output}\n`);
      return exitCodes.error;
    }
    if (transport.specErrors && transport.specErrors.length > 0) {
      for (const e of transport.specErrors)
        o.stderr(`${e.module}${e.line > 0 ? `:${e.line}` : ""}: ${e.message}\n`);
      return exitCodes.error;
    }
    const report = transport.report as { verdict: ScenarioVerdict; specs?: readonly SpecVerdict[] };
    const verdict = report.verdict;
    let specs = report.specs ?? [];
    if (o.provers && o.provers.length > 0) {
      const named = enginesNamed(o.provers);
      if ("error" in named) {
        o.stderr(`${named.error}\n`);
        return exitCodes.error;
      }
      specs = await proveSpecs(dir, transport.observed ?? [], specs, named.engines, specModules);
    }
    const printed =
      o.provers && o.provers.length > 0
        ? { ...(transport.report as object), specs }
        : transport.report;
    if (o.json) o.stdout(`${canonicalJson(printed as JsonValue)}\n`);
    else o.stdout(`${renderText(verdict)}\n${specs.length > 0 ? `\n${renderSpecs(specs)}\n` : ""}`);

    if (verdict.kind === "VIOLATED" && !o.noRegression) {
      const outPath = o.out ? resolve(o.cwd, o.out) : join(dir, `${name}.regression.test.ts`);
      const outDir = dirname(outPath);
      const schemaPaths: Record<string, string> = {};
      for (const step of transport.setup) {
        if (step.kind === "d1") {
          schemaPaths[String(step["binding"])] = toPosix(
            relative(outDir, resolve(dir, String(step["schemaFile"]))),
          );
        }
      }
      const source = cloudflareRegressionTest(verdict as Violated, {
        scenarioPath: toPosix(relative(outDir, scenarioPath)),
        workerPath: toPosix(relative(outDir, resolve(dir, transport.worker.entry))),
        schemaPaths,
        ...(o.budgetMs === undefined ? {} : { budgetMs: o.budgetMs }),
        ...(transport.setup.some((s) => s.kind === "durable_object")
          ? { durableObjects: true }
          : {}),
        ...(transport.setup.some((s) => s.kind === "workflow") ? { workflows: true } : {}),
        ...(o.expectViolation ? { expect: "violates" as const } : {}),
        ...((transport.observed ?? []).length > 0
          ? {
              specModules: (transport.observed ?? []).map((m) => ({
                path: toPosix(relative(outDir, resolve(dir, m.module))),
                functions: m.functions,
              })),
            }
          : {}),
      });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(outPath, source);
      if (!o.json)
        o.stdout(`\nRegression test written to ${relative(o.cwd, outPath) || outPath}\n`);
    }
    // A refuted spec fails the check like a violation does; so does a conflict between engines.
    if (
      verdict.kind !== "VIOLATED" &&
      specs.some((v) => v.kind === "REFUTED" || v.kind === "CONFLICT")
    )
      return exitCodes.VIOLATED;
    return exitCodes[verdict.kind];
  } finally {
    if (!o.keep) rmSync(workDir, { recursive: true, force: true });
  }
}
