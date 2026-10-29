import { defineConfig } from "tsdown";

/**
 * The published package, built from the repository root so declaration
 * generation can see every package's sources: the facade's entry points
 * with every internal `@eutaxy/*` package bundled in, ESM only, with bundled
 * declarations. Peer dependencies (vitest, the Cloudflare plugin, the
 * TypeScript compiler the reader runs) and Node built-ins stay external:
 * the compiler is named explicitly, since the workspace also holds it as a
 * dev dependency, which would otherwise bundle it.
 */
export default defineConfig({
  entry: {
    index: "packages/eutaxy/src/index.ts",
    cloudflare: "packages/eutaxy/src/cloudflare.ts",
    aws: "packages/eutaxy/src/aws.ts",
    spec: "packages/eutaxy/src/spec.ts",
    cli: "packages/eutaxy/src/cli.ts",
    bin: "packages/eutaxy/src/bin.ts",
  },
  outDir: "packages/eutaxy/dist",
  format: "esm",
  platform: "node",
  target: "node24",
  dts: { tsconfig: "tsconfig.dts.json" },
  clean: true,
  deps: { alwaysBundle: [/^@eutaxy\//] },
  external: [/^typescript(\/|$)/],
  outputOptions: {
    banner: (chunk) => (chunk.name === "bin" ? "#!/usr/bin/env node" : ""),
  },
});
