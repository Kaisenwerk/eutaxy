# @eutaxy/prover

**Purpose.** The `Prover` interface, the spec ladder (`CHECKED`, `TESTED`, `PROVEN`), aggregation across engines, and the reader of the pure
TypeScript subset the engines share.

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
check generated predicates are given), `inDomain`, `render`. The `PROVEN`
rung: the `Prover` interface every engine implements (`available`, `prove`
over a module's source, answering `PROVEN`, `REFUTED` or `UNKNOWN` per
property as `ProofOutcome`), and `aggregate` (the simulator's verdicts
folded with the engines' reports: `PROVEN` with the lower rungs' counts,
`REFUTED` at the `PROVEN` rung, `CONFLICT` when engines disagree or an
engine proves against a simulator counterexample, the verdict unchanged
with a note when an engine fell short). Nothing here spawns an engine.

**The reader** (`@eutaxy/prover/reader`, a subpath so workerd never loads
it): `readSubset` and `readExpression` read the subset every first-party
engine translates: exported functions over `number` (as unbounded
integers), `boolean` and `string` (string-literal unions read as string),
returning those or a record type declared in the module, with `const`, `if`
and early returns, `+ - *`, `+` joining strings, comparisons, `&& || !`, the
conditional operator, string and record literals, field reads and calls to
the module's own functions; a function outside it, or calling one, is
reported with the construct and the line, and the rest of the module still
goes through. `typeOf` types an expression of the tree.

**May import.** `@eutaxy/core`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5 (`CHECKED`), v0.6 (`TESTED`, `PROVEN`, aggregation). See `docs/design.md` and `docs/roadmap.md`.
