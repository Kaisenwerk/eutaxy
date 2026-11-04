import type { Violated } from "@eutaxy/core";
import { emitRegressionTest } from "@eutaxy/report";

export interface CloudflareRegressionOptions {
  /** Import path of the scenario module, relative to the emitted file. */
  readonly scenarioPath: string;
  /** Import path of the Worker module. */
  readonly workerPath: string;
  /** D1 binding name to schema file path, imported with `?raw`. */
  readonly schemaPaths: Readonly<Record<string, string>>;
  /**
   * The time budget the check ran with, when it replaced the scenario's: the
   * replay gets the same, so I/O that finished within it does not time out.
   */
  readonly budgetMs?: number;
  /** The platform's retry limit, when the scenario was checked with a non-default one. */
  readonly maxRetries?: number;
  /** The scenario sets up Durable Objects: pass the Cloudflare test helpers to the platform. */
  readonly durableObjects?: boolean;
  /**
   * Pass the Worker module's exports to the platform: the scenario sets up
   * Workflows (their classes are among them) or drives a named entrypoint.
   */
  readonly exports?: boolean;
  /** @deprecated Use `exports`. */
  readonly workflows?: boolean;
  /**
   * The Workers behind service bindings the scenario names with `callee`, by
   * binding: each one's name from its wrangler config and the import path of
   * its module.
   */
  readonly callees?: Readonly<Record<string, { readonly name: string; readonly path: string }>>;
  /**
   * The qualified names the callees' bindings had in the check's isolate: the
   * replay needs them in its own, so the test says so at its top.
   */
  readonly calleeBindings?: readonly string[];
  readonly expect?: "holds" | "violates";
  readonly engineModule?: string;
  /** Core modules to observe during the replay (import path, functions), for `refines`. */
  readonly specModules?: readonly {
    readonly path: string;
    readonly functions: readonly string[];
  }[];
}

/**
 * Identifiers for binding names: a qualified name (`orders/DB`) becomes
 * `orders_DB`, and a name whose identifier another already took gets a
 * count (`orders_DB_2`), so two imports never share a name.
 */
function identifiers(names: readonly string[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const name of names) {
    const base = name.replace(/[^A-Za-z0-9_$]/g, "_");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    out.set(name, id);
  }
  return out;
}
/** A binding name as an object key: bare where it is an identifier, quoted otherwise. */
const key = (binding: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(binding) ? binding : JSON.stringify(binding);

/** A Vitest regression test for a Cloudflare scenario, to run under the Cloudflare Vitest plugin. */
export function cloudflareRegressionTest(
  verdict: Violated,
  options: CloudflareRegressionOptions,
): string {
  const bindings = Object.keys(options.schemaPaths).sort();
  const callees = Object.keys(options.callees ?? {}).sort();
  const schemaIds = identifiers(bindings);
  const calleeIds = identifiers(callees);
  const ident = (binding: string): string =>
    schemaIds.get(binding) ?? calleeIds.get(binding) ?? binding;
  const withExports = options.exports === true || options.workflows === true;
  const note =
    callees.length === 0 || (options.calleeBindings ?? []).length === 0
      ? []
      : [
          `// Needs the callees' bindings in this test's isolate under their qualified names: ${(options.calleeBindings ?? []).join(", ")}.`,
          "// Declare them in the wrangler config, or run this test under the config eutaxy check --keep leaves in .eutaxy/.",
        ];
  const imports = [
    ...note,
    'import { createCloudflarePlatform } from "eutaxy/cloudflare";',
    'import { env } from "cloudflare:workers";',
    ...(options.durableObjects ? ['import * as cloudflareTest from "cloudflare:test";'] : []),
    `import scenario from ${JSON.stringify(options.scenarioPath)};`,
    ...bindings.map(
      (b) => `import schema_${ident(b)} from ${JSON.stringify(`${options.schemaPaths[b]}?raw`)};`,
    ),
    ...callees.map(
      (b) =>
        `import * as callee_${calleeIds.get(b)} from ${JSON.stringify(options.callees?.[b]?.path)};`,
    ),
    withExports
      ? `import * as worker from ${JSON.stringify(options.workerPath)};`
      : `import handler from ${JSON.stringify(options.workerPath)};`,
    ...(options.specModules ?? []).map(
      (m, i) => `import * as core_${i} from ${JSON.stringify(m.path)};`,
    ),
  ];
  const schemas = `{ ${bindings.map((b) => `${key(b)}: schema_${ident(b)}`).join(", ")} }`;
  const calleeOption =
    callees.length === 0
      ? ""
      : `, callees: { ${callees
          .map(
            (b) =>
              `${key(b)}: { name: ${JSON.stringify(options.callees?.[b]?.name)}, exports: callee_${calleeIds.get(b)} }`,
          )
          .join(", ")} }`;
  const retries = options.maxRetries === undefined ? "" : `, maxRetries: ${options.maxRetries}`;
  const objects = options.durableObjects ? ", durableObjects: cloudflareTest" : "";
  const handler = withExports ? "handler: worker.default" : "handler";
  const exports = withExports ? ", exports: worker" : "";
  return emitRegressionTest(verdict, {
    imports,
    platform: `createCloudflarePlatform({ env, ${handler}, schemas: ${schemas}${retries}${objects}${exports}${calleeOption} })`,
    scenario:
      options.budgetMs === undefined
        ? "scenario"
        : `{ ...scenario, bounds: { ...scenario.bounds, budgetMs: ${options.budgetMs} } }`,
    ...(options.expect ? { expect: options.expect } : {}),
    ...(options.engineModule ? { engineModule: options.engineModule } : {}),
    ...(options.specModules && options.specModules.length > 0
      ? {
          observe: options.specModules.map((m, i) => ({
            namespace: `core_${i}`,
            functions: m.functions,
          })),
        }
      : {}),
  });
}
