# @eutaxy/prover-lemmascript

**Purpose.** Optional process-boundary adapter for the LemmaScript engine.

**Public surface.** Nothing yet. From v0.6.x: a `Prover` implementation.

**May import.** `@eutaxy/prover`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.6.x. See `docs/design.md` and `docs/roadmap.md`.
