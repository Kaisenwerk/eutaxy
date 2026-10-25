# @eutaxy/prover

**Purpose.** The `Prover` interface, the spec ladder (`CHECKED`, `TESTED`, `PROVEN`) and aggregation across engines.

**Public surface.** The ladder: `specLadder` (one property through
`CHECKED`, then `TESTED`; a counterexample at either rung is `REFUTED`),
`checkSpecModule` (every verdict for one module, markers included, with
`LadderOptions`). The `CHECKED` rung: `checkedRung` (one property on the
calls the simulator made: binders matched to parameters by name, values
outside a binder's domain or guard and failed preconditions discarded). The
`TESTED` rung: `testedRung` (one property on assignments drawn from the
binders' domains with a seed, a refuting one shrunk), `generate` and
`shrinkCandidates` (values of a binder's domain and guard, regex guards
walked by `regex-gen.ts`). Shared: `evaluate` (one assignment through a
predicate: an outcome, or a malformed property), `lemmaBool` (the atom
check generated predicates are given), `inDomain`, `render`. From v0.6:
`Prover`, the `PROVEN` rung, `aggregate`.

**May import.** `@eutaxy/core`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5 (`CHECKED`), v0.6 (`TESTED`, provers). See `docs/design.md` and `docs/roadmap.md`.
