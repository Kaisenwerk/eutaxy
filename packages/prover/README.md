# @eutaxy/prover

**Purpose.** The `Prover` interface, the spec ladder (`CHECKED`, `TESTED`, `PROVEN`) and aggregation across engines.

**Public surface.** The `CHECKED` rung: `checkedRung` (one property on the
calls the simulator made: binders matched to parameters by name, values
outside a binder's domain or guard and failed preconditions discarded),
`checkSpecModule` (every verdict for one module, markers included),
`lemmaBool` (the atom check generated predicates are given), `inDomain`,
`render`. From v0.6: `Prover`, `runLadder`, `aggregate`.

**May import.** `@eutaxy/core`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5 (`CHECKED`), v0.6 (provers). See `docs/design.md` and `docs/roadmap.md`.
