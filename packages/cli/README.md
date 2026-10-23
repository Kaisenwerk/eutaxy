# @eutaxy/cli

**Purpose.** The `eutaxy` command: `check`, `prove`, `report`, `prover install`, config loading, engine discovery.

**Public surface.** `main` (the command), `runCheck`, `cloudflareRegressionTest`, the generators for the check test and Vitest config. `eutaxy check <scenario.sim.ts>` writes `<dir>/.eutaxy/`, runs the user's Vitest with the Cloudflare plugin there, reads the verdict back from the test's task meta through Vitest's JSON reporter, prints text or `--json`, writes `<name>.regression.test.ts` on a violation, and exits 0/1/2 for BOUNDED/VIOLATED/UNSUPPORTED.

**May import.** `@eutaxy/spec`, `@eutaxy/core`, `@eutaxy/engine`, `@eutaxy/cloudflare`, `@eutaxy/prover`, `@eutaxy/prover-lean`, `@eutaxy/prover-thales`, `@eutaxy/prover-lemmascript`, `@eutaxy/report`, `@eutaxy/aws`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.1. See `docs/design.md` and `docs/roadmap.md`.
