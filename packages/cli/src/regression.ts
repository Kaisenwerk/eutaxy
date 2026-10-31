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
  readonly expect?: "holds" | "violates";
  readonly engineModule?: string;
  /** Core modules to observe during the replay (import path, functions), for `refines`. */
  readonly specModules?: readonly {
    readonly path: string;
    readonly functions: readonly string[];
  }[];
}

/** A Vitest regression test for a Cloudflare scenario, to run under the Cloudflare Vitest plugin. */
export function cloudflareRegressionTest(
  verdict: Violated,
  options: CloudflareRegressionOptions,
): string {
  const bindings = Object.keys(options.schemaPaths).sort();
  const withExports = options.exports === true || options.workflows === true;
  const imports = [
    'import { createCloudflarePlatform } from "eutaxy/cloudflare";',
    'import { env } from "cloudflare:workers";',
    ...(options.durableObjects ? ['import * as cloudflareTest from "cloudflare:test";'] : []),
    `import scenario from ${JSON.stringify(options.scenarioPath)};`,
    ...bindings.map(
      (b) => `import schema_${b} from ${JSON.stringify(`${options.schemaPaths[b]}?raw`)};`,
    ),
    withExports
      ? `import * as worker from ${JSON.stringify(options.workerPath)};`
      : `import handler from ${JSON.stringify(options.workerPath)};`,
    ...(options.specModules ?? []).map(
      (m, i) => `import * as core_${i} from ${JSON.stringify(m.path)};`,
    ),
  ];
  const schemas = `{ ${bindings.map((b) => `${b}: schema_${b}`).join(", ")} }`;
  const retries = options.maxRetries === undefined ? "" : `, maxRetries: ${options.maxRetries}`;
  const objects = options.durableObjects ? ", durableObjects: cloudflareTest" : "";
  const handler = withExports ? "handler: worker.default" : "handler";
  const exports = withExports ? ", exports: worker" : "";
  return emitRegressionTest(verdict, {
    imports,
    platform: `createCloudflarePlatform({ env, ${handler}, schemas: ${schemas}${retries}${objects}${exports} })`,
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
