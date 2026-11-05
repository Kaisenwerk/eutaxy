import type { Violated } from "@eutaxy/core";
import { emitRegressionTest } from "@eutaxy/report";

/**
 * What `cloudflareRegressionTest` needs to write the test: import paths of the scenario, the Worker and its
 * schema files, relative to the emitted file, and what the platform was given when the check ran.
 */
export interface CloudflareRegressionOptions {
  /** Import path of the scenario module, relative to the emitted file. */
  readonly scenarioPath: string;
  /** Import path of the Worker module. */
  readonly workerPath: string;
  /** D1 binding name to its schema file path, or its files in setup order (joined), imported with `?raw`. */
  readonly schemaPaths: Readonly<Record<string, string | readonly string[]>>;
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
  readonly callees?: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly path: string;
        readonly entrypoint?: string;
        readonly props?: Readonly<Record<string, unknown>>;
      }
    >
  >;
  /**
   * The qualified names the callees' bindings had in the check's isolate: the
   * replay needs them in its own, so the test says so at its top.
   */
  readonly calleeBindings?: readonly string[];
  /** Qualified binding names that are aliases of the caller's bindings, passed to the platform. */
  readonly aliases?: Readonly<Record<string, string>>;
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
  /**
   * Each binding's files, in setup order, each with an identifier of its own: the binding's name for the
   * first, a count after it for the later ones, made unique across all files as `identifiers` does.
   */
  const taken = new Set<string>();
  const files = bindings.flatMap((b) => {
    const paths = options.schemaPaths[b] ?? [];
    return (typeof paths === "string" ? [paths] : paths).map((path, i) => {
      const base = (i === 0 ? b : `${b}_${i + 1}`).replace(/[^A-Za-z0-9_$]/g, "_");
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      taken.add(id);
      return { binding: b, path, id };
    });
  });
  const calleeIds = identifiers(callees);
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
    ...files.map((f) => `import schema_${f.id} from ${JSON.stringify(`${f.path}?raw`)};`),
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
  const schemaOf = (b: string): string => {
    const own = files.filter((f) => f.binding === b).map((f) => `schema_${f.id}`);
    return own.length === 1 ? (own[0] as string) : `[${own.join(", ")}].join("\\n;\\n")`;
  };
  const schemas = `{ ${bindings.map((b) => `${key(b)}: ${schemaOf(b)}`).join(", ")} }`;
  const calleeOption =
    callees.length === 0
      ? ""
      : `, callees: { ${callees
          .map(
            (b) =>
              `${key(b)}: { name: ${JSON.stringify(options.callees?.[b]?.name)}, exports: callee_${calleeIds.get(b)}${options.callees?.[b]?.entrypoint === undefined ? "" : `, entrypoint: ${JSON.stringify(options.callees?.[b]?.entrypoint)}`}${options.callees?.[b]?.props === undefined ? "" : `, props: ${JSON.stringify(options.callees?.[b]?.props)}`} }`,
          )
          .join(", ")} }`;
  const retries = options.maxRetries === undefined ? "" : `, maxRetries: ${options.maxRetries}`;
  const aliases =
    options.aliases === undefined || Object.keys(options.aliases).length === 0
      ? ""
      : `, aliases: ${JSON.stringify(options.aliases)}`;
  const objects = options.durableObjects ? ", durableObjects: cloudflareTest" : "";
  const handler = withExports ? "handler: worker.default" : "handler";
  const exports = withExports ? ", exports: worker" : "";
  return emitRegressionTest(verdict, {
    imports,
    platform: `createCloudflarePlatform({ env, ${handler}, schemas: ${schemas}${retries}${objects}${exports}${calleeOption}${aliases} })`,
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
