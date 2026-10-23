# eutaxy

**Purpose.** The published facade: `eutaxy` and `eutaxy/cloudflare`. Internal packages are bundled into it at build time.

**Public surface.** `.`: scenario and verdict types, `checkInvariants`, `explore`, `replay`, `restrictSpec`, `renderText`, `renderJson`, `emitRegressionTest`. `./cloudflare`: everything from the cloudflare package plus `cloudflareRegressionTest`. `./aws`: everything from the aws package.

**Build.** `pnpm build` at the repository root bundles every internal
package into `dist/` (tsdown, ESM, bundled declarations); `publishConfig`
swaps the workspace entry points for `dist/` on publish, and the internal
packages are dev dependencies so the published manifest has none at runtime.

**May import.** `@eutaxy/spec`, `@eutaxy/core`, `@eutaxy/engine`, `@eutaxy/cloudflare`, `@eutaxy/prover`, `@eutaxy/prover-lean`, `@eutaxy/prover-thales`, `@eutaxy/prover-lemmascript`, `@eutaxy/report`, `@eutaxy/cli`, `@eutaxy/aws`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4. See `docs/design.md` and `docs/roadmap.md`.
