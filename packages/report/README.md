# @eutaxy/report

**Purpose.** Text and versioned JSON reports, and the Vitest regression-test emitter.

**Public surface.** `renderText` (verdict, schedule, marked trace, assumptions), `renderTrace`, `renderJson` (canonical JSON with `schemaVersion` 1), `emitRegressionTest` (a Vitest file replaying a shrunk schedule; platform supplied by the caller as import lines and an expression).

**May import.** `@eutaxy/core`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.1. See `docs/design.md` and `docs/roadmap.md`.
