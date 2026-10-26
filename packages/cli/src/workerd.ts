/**
 * The half of `eutaxy check` that runs inside workerd: the generated test
 * passes its module globs here and stores what this returns in its task
 * meta, which the CLI reads back. It imports nothing that needs Node, so
 * the Cloudflare Vitest plugin can load it.
 */

import {
  check,
  createCloudflarePlatform,
  type DurableObjectTestHelpers,
  type WorkerHandler,
} from "@eutaxy/cloudflare";
import type { ScenarioSpec, SpecVerdict } from "@eutaxy/core";
import { observeCore } from "@eutaxy/engine";
import { checkSpecModule } from "@eutaxy/prover";
import { renderJson } from "@eutaxy/report";
import type { ModuleSpecs } from "@eutaxy/spec";
import { globKey, specKey } from "./keys.ts";

/** What the generated test stores in its task meta. */
export interface CheckTransport {
  readonly report: unknown;
  /** Set instead of a report when a module the scenario's `specs` names has no usable spec file. */
  readonly specErrors?: readonly SpecError[];
  readonly worker: { readonly entry: string; readonly config: string };
  readonly setup: readonly { readonly kind: string; readonly [key: string]: unknown }[];
  /** The core modules observed (as the scenario's specs name them) and the functions on each. */
  readonly observed?: readonly { readonly module: string; readonly functions: readonly string[] }[];
}

export interface SpecError {
  readonly module: string;
  readonly line: number;
  readonly message: string;
}

/** A generated spec entry: the module's specs, read on the Node side, and a loader of its spec file. */
export interface SpecEntry {
  readonly specs: ModuleSpecs;
  readonly load: () => Promise<object>;
}

/** Vite globs, keyed as `import.meta.glob` keys them from `.eutaxy/` (see `globKey`). */
export type ModuleGlob = Readonly<Record<string, () => Promise<unknown>>>;

/** Each D1 binding's schema, read from the `.sql` files next to the scenario. */
export function schemasFor(
  scenario: ScenarioSpec,
  sqlFiles: Readonly<Record<string, string>>,
): Record<string, string> {
  const schemas: Record<string, string> = {};
  for (const step of scenario.setup) {
    if (step.kind !== "d1") continue;
    const file = String(step["schemaFile"]);
    const sql = sqlFiles[globKey(file)];
    if (sql === undefined) throw new Error(`schema file ${file} not found next to the scenario`);
    schemas[String(step["binding"])] = sql;
  }
  return schemas;
}

export interface SelectedModule {
  /** As the scenario names it. */
  readonly path: string;
  readonly key: string;
  readonly namespace: object;
  readonly specs: ModuleSpecs;
  /** The spec file's namespace: its exports are the specs. */
  readonly props: Readonly<Record<string, unknown>>;
  /** The functions observed: the ones with specs, and the decisions `refines` names that the module exports. */
  readonly names: readonly string[];
}

/**
 * The modules the scenario's `specs` name, loaded with their specs and
 * their spec files, and every reason the check cannot go ahead: a module
 * that is not there, a spec that does not read, a function name observed
 * in two modules (decisions are logged by name, so it would be ambiguous).
 * The spec files are loaded here, before anything is observed, so the
 * functions their specs hold are the modules' own.
 */
export async function selectSpecModules(
  scenario: ScenarioSpec,
  modules: ModuleGlob,
  specEntries: Readonly<Record<string, SpecEntry>>,
): Promise<{
  readonly selected: readonly SelectedModule[];
  readonly specErrors: readonly SpecError[];
}> {
  const decisions = scenario.invariants.flatMap((i) => (i.kind === "refines" ? [i.decision] : []));
  const specErrors: SpecError[] = [];
  const selected: SelectedModule[] = [];
  for (const path of scenario.specs ?? []) {
    const load = modules[globKey(path)];
    if (!load) {
      specErrors.push({ module: path, line: 0, message: "no such module next to the scenario" });
      continue;
    }
    const namespace = (await load()) as Record<string, unknown>;
    const key = specKey(path);
    const entry = Object.hasOwn(specEntries, key) ? specEntries[key] : undefined;
    const specs: ModuleSpecs = entry?.specs ?? { functions: [], errors: [] };
    for (const e of specs.errors)
      specErrors.push({
        module: e.inModule ? path : `${path.replace(/\.ts$/, "")}.props.ts`,
        line: e.line,
        message: e.message,
      });
    const props = entry ? ((await entry.load()) as Record<string, unknown>) : {};
    const exported = decisions.filter((d) => typeof namespace[d] === "function");
    const names = [...new Set([...specs.functions.map((f) => f.name), ...exported])];
    selected.push({ path, key, namespace, specs, props, names });
  }
  const observedIn = new Map<string, string>();
  for (const m of selected)
    for (const n of m.names) {
      const other = observedIn.get(n);
      if (other === undefined) observedIn.set(n, m.path);
      else
        specErrors.push({
          module: m.path,
          line: 0,
          message: `${n} is observed in both ${other} and ${m.path}; decisions of one name must come from one module`,
        });
    }
  return { selected, specErrors };
}

export interface WorkerdCheckInput {
  /** The scenario module's default export. */
  readonly scenario: ScenarioSpec;
  /** `env` from `cloudflare:workers`. */
  readonly env: object;
  /** The `cloudflare:test` module, for Durable Objects. */
  readonly durableObjects: DurableObjectTestHelpers;
  /** The raw text of the `.sql` files next to the scenario. */
  readonly sqlFiles: Readonly<Record<string, string>>;
  /** The TypeScript modules next to the scenario (the Worker and the spec modules among them). */
  readonly modules: ModuleGlob;
  /** The generated `specs.ts` entries, by module key. */
  readonly specEntries: Readonly<Record<string, SpecEntry>>;
  readonly seed: string;
  readonly maxRuns?: number;
  readonly budgetMs?: number;
  readonly exhaustive?: boolean;
}

/** Run the scenario's check, with its specs observed, and return what the CLI reads back. */
export async function checkInWorkerd(input: WorkerdCheckInput): Promise<CheckTransport> {
  const { scenario } = input;
  const schemas = schemasFor(scenario, input.sqlFiles);
  const load = input.modules[globKey(scenario.worker.entry)];
  if (!load)
    throw new Error(`worker entry ${scenario.worker.entry} not found next to the scenario`);
  const worker = (await load()) as { default: WorkerHandler } & Record<string, unknown>;
  const platform = createCloudflarePlatform({
    env: input.env,
    handler: worker.default,
    schemas,
    durableObjects: input.durableObjects,
    exports: worker,
  });
  const { selected, specErrors } = await selectSpecModules(
    scenario,
    input.modules,
    input.specEntries,
  );
  const transportBase = { worker: scenario.worker, setup: scenario.setup };
  if (specErrors.length > 0) return { report: null, specErrors, ...transportBase };
  const observers = selected.map((m) => observeCore(m.namespace, m.names));
  let verdict: Awaited<ReturnType<typeof check>>;
  try {
    verdict = await check(scenario, platform, {
      seed: input.seed,
      ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
      ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
      ...(input.exhaustive ? { exhaustive: true } : {}),
    });
  } finally {
    for (const o of observers) o.restore();
  }
  // CHECKED on the calls the exploration recorded, then TESTED on inputs drawn from the check's seed.
  const specs: SpecVerdict[] = selected.flatMap((m, i) =>
    checkSpecModule(
      m.key,
      m.specs,
      m.props,
      m.namespace as Record<string, unknown>,
      observers[i] as ReturnType<typeof observeCore>,
      { tested: { seed: input.seed } },
    ),
  );
  return {
    report: JSON.parse(renderJson(verdict, specs)) as unknown,
    ...transportBase,
    observed: selected.map((m) => ({ module: m.path, functions: m.names })),
  };
}
