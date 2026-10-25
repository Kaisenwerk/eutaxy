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
import { checkSpecModule, lemmaBool, lemmaUnresolved, type ModulePredicates } from "@eutaxy/prover";
import { renderJson } from "@eutaxy/report";
import type { ModuleSpecs } from "@eutaxy/spec";
import { globKey, specKey } from "./keys.ts";

/** What the generated test stores in its task meta. */
export interface CheckTransport {
  readonly report: unknown;
  /** Set instead of a report when a module the scenario's `specs` names has no usable annotations. */
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

/** A generated spec module: the module's extracted specs and its compiled predicates. */
export interface SpecEntry {
  readonly specs: ModuleSpecs;
  readonly predicates: (
    namespace: object,
    bool: typeof lemmaBool,
    unresolved: typeof lemmaUnresolved,
  ) => ModulePredicates;
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
  readonly predicates: ModulePredicates;
  /** The functions observed: the annotated ones, and the decisions `refines` names that the module exports. */
  readonly names: readonly string[];
}

/**
 * The modules the scenario's `specs` name, loaded with their specs, and
 * every reason the check cannot go ahead: a module that is not there, an
 * annotation that does not parse, a function name observed in two modules
 * (decisions are logged by name, so it would be ambiguous).
 */
export async function selectSpecModules(
  scenario: ScenarioSpec,
  modules: ModuleGlob,
  specLoaders: Readonly<Record<string, () => Promise<SpecEntry>>>,
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
    const loadSpec = Object.hasOwn(specLoaders, key) ? specLoaders[key] : undefined;
    const entry = loadSpec ? await loadSpec() : undefined;
    const specs: ModuleSpecs = entry?.specs ?? { functions: [], exports: [], errors: [] };
    for (const e of specs.errors) specErrors.push({ module: path, ...e });
    const exported = decisions.filter((d) => typeof namespace[d] === "function");
    const names = [...new Set([...specs.functions.map((f) => f.name), ...exported])];
    const predicates = entry ? entry.predicates(namespace, lemmaBool, lemmaUnresolved) : {};
    selected.push({ path, key, namespace, specs, predicates, names });
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
  /** The generated `specs.ts` loaders, by module key. */
  readonly specLoaders: Readonly<Record<string, () => Promise<SpecEntry>>>;
  readonly seed: string;
  readonly maxRuns?: number;
  readonly exhaustive?: boolean;
}

/** Run the scenario's check, with its specs observed, and return what the CLI reads back. */
export async function checkInWorkerd(input: WorkerdCheckInput): Promise<CheckTransport> {
  const { scenario } = input;
  const schemas = schemasFor(scenario, input.sqlFiles);
  const load = input.modules[globKey(scenario.worker.entry)];
  if (!load)
    throw new Error(`worker entry ${scenario.worker.entry} not found next to the scenario`);
  const handler = ((await load()) as { default: WorkerHandler }).default;
  const platform = createCloudflarePlatform({
    env: input.env,
    handler,
    schemas,
    durableObjects: input.durableObjects,
  });
  const { selected, specErrors } = await selectSpecModules(
    scenario,
    input.modules,
    input.specLoaders,
  );
  const transportBase = { worker: scenario.worker, setup: scenario.setup };
  if (specErrors.length > 0) return { report: null, specErrors, ...transportBase };
  const observers = selected.map((m) => observeCore(m.namespace, m.names));
  let verdict: Awaited<ReturnType<typeof check>>;
  try {
    verdict = await check(scenario, platform, {
      seed: input.seed,
      ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
      ...(input.exhaustive ? { exhaustive: true } : {}),
    });
  } finally {
    for (const o of observers) o.restore();
  }
  const specs: SpecVerdict[] = selected.flatMap((m, i) =>
    checkSpecModule(m.key, m.specs, m.predicates, observers[i] as ReturnType<typeof observeCore>),
  );
  return {
    report: JSON.parse(renderJson(verdict, specs)) as unknown,
    ...transportBase,
    observed: selected.map((m) => ({ module: m.path, functions: m.names })),
  };
}
