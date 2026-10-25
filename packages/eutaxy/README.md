# eutaxy

**Purpose.** The published facade: `eutaxy` and `eutaxy/cloudflare`. Internal packages are bundled into it at build time.

**Public surface.** `.`: scenario, invariant (`Refines` included) and verdict types, for scenarios and specs (`SpecVerdict`); `checkInvariants`, `explore`, `replay`, `restrictSpec`; `observeCore` (record a core module's calls as decisions); Lemma specs (`parseProperty`, `printProperty`, `extractSpecs`, the `SpecIR` types) and the `CHECKED` rung (`checkedRung`; `checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and `ModulePredicates` are deprecated, internal to `eutaxy check`, and go in 0.6.0); `renderText`, `renderJson`, `renderSpecs`, `emitRegressionTest`. `./cloudflare`: everything from the cloudflare package (`refines` and `d1Read` among it) plus `cloudflareRegressionTest` and `checkInWorkerd` (what the test `eutaxy check` generates calls). `./aws`: everything from the aws package.

**Build.** `pnpm build` at the repository root bundles every internal
package into `dist/` (tsdown, ESM, bundled declarations); `publishConfig`
swaps the workspace entry points for `dist/` on publish, and the internal
packages are dev dependencies so the published manifest has none at runtime.

**May import.** `@eutaxy/spec`, `@eutaxy/core`, `@eutaxy/engine`, `@eutaxy/cloudflare`, `@eutaxy/prover`, `@eutaxy/prover-lean`, `@eutaxy/prover-thales`, `@eutaxy/prover-lemmascript`, `@eutaxy/report`, `@eutaxy/cli`, `@eutaxy/aws`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4 onward. See `docs/design.md` and `docs/roadmap.md`.
