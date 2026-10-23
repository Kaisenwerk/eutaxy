# @eutaxy/spec

**Purpose.** `SpecIR`, the Lemma annotation parser and printer.

**Public surface.** Nothing yet. From v0.5: `SpecIR`, `parseSpec`, `printSpec`.

**May import.** nothing outside this package. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5. See `docs/design.md` and `docs/roadmap.md`.
