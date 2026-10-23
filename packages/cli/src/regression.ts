import type { Violated } from "@eutaxy/core";
import { emitRegressionTest } from "@eutaxy/report";

export interface CloudflareRegressionOptions {
  /** Import path of the scenario module, relative to the emitted file. */
  readonly scenarioPath: string;
  /** Import path of the Worker module. */
  readonly workerPath: string;
  /** D1 binding name to schema file path, imported with `?raw`. */
  readonly schemaPaths: Readonly<Record<string, string>>;
  /** The platform's retry limit, when the scenario was checked with a non-default one. */
  readonly maxRetries?: number;
  readonly expect?: "holds" | "violates";
  readonly engineModule?: string;
}

/** A Vitest regression test for a Cloudflare scenario, to run under the Cloudflare Vitest plugin. */
export function cloudflareRegressionTest(
  verdict: Violated,
  options: CloudflareRegressionOptions,
): string {
  const bindings = Object.keys(options.schemaPaths).sort();
  const imports = [
    'import { createCloudflarePlatform } from "eutaxy/cloudflare";',
    'import { env } from "cloudflare:workers";',
    `import scenario from ${JSON.stringify(options.scenarioPath)};`,
    ...bindings.map(
      (b) => `import schema_${b} from ${JSON.stringify(`${options.schemaPaths[b]}?raw`)};`,
    ),
    `import handler from ${JSON.stringify(options.workerPath)};`,
  ];
  const schemas = `{ ${bindings.map((b) => `${b}: schema_${b}`).join(", ")} }`;
  const retries = options.maxRetries === undefined ? "" : `, maxRetries: ${options.maxRetries}`;
  return emitRegressionTest(verdict, {
    imports,
    platform: `createCloudflarePlatform({ env, handler, schemas: ${schemas}${retries} })`,
    scenario: "scenario",
    ...(options.expect ? { expect: options.expect } : {}),
    ...(options.engineModule ? { engineModule: options.engineModule } : {}),
  });
}
