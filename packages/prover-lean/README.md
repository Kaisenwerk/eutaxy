# @eutaxy/prover-lean

**Purpose.** Eutaxy's first-party engine: a pure TypeScript subset to Lean 4, a curated tactic stack, translation validation.

**Public surface.** Nothing yet. From v0.6: a `Prover` implementation.

**May import.** `@eutaxy/prover`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.6. See `docs/design.md` and `docs/roadmap.md`.
