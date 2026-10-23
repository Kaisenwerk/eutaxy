# @eutaxy/prover

**Purpose.** The `Prover` interface, the spec ladder (`CHECKED`, `TESTED`, `PROVEN`) and aggregation across engines.

**Public surface.** Nothing yet. From v0.6: `Prover`, `runLadder`, `aggregate`.

**May import.** `@eutaxy/core`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.6. See `docs/design.md` and `docs/roadmap.md`.
