# @eutaxy/prover

**Purpose.** The `Prover` interface, the spec ladder (`CHECKED`, `TESTED`,
`PROVEN`), aggregation across engines, and the reader: a module and its
spec file into `SpecIR`, and the pure TypeScript subset the engines share
into one tree.

**Public surface.** The ladder: `specLadder` (one property through
`CHECKED`, then `TESTED`; a counterexample at either rung is `REFUTED`),
`checkSpecModule` (every verdict for one module, given the spec file's
namespace and the module's, with `LadderOptions`; `checked: false` starts
the ladder at `TESTED` when no scenario ran, as in `eutaxy report`). The `CHECKED` rung:
`checkedRung` (one property on the calls the simulator made: the binders
are the function's parameters, the precondition discarding). The `TESTED`
rung: `testedRung` (one property on assignments drawn from the parameter
types with a seed, every edge first (`edgesOf`, `edgeLists`,
`edgeAssignment`, `edgeAssignmentCount`), then random draws, at least half
the budget; a refuting one shrunk), `generate`, `generateOf` and
`shrinkCandidates` (values of a type within its hint: integers, doubles,
bigints, strings with regex hints walked by `regex-gen.ts`, literals,
unions, records, arrays), `conforms`, `inDomain`. Shared: `evaluate` (one
assignment through a spec's `when` and `ensures`: held, discarded,
refuted, or a malformed property), `render`. The `PROVEN` rung: the
`Prover` interface every engine implements (`available`, `prove` over a
module's source and its specs, answering `PROVEN`, `REFUTED` or `UNKNOWN`
per property as `ProofOutcome`), and `aggregate` (the simulator's verdicts
folded with the engines' reports: `PROVEN` with the lower rungs' counts,
`REFUTED` at the `PROVEN` rung, `CONFLICT` when engines disagree or an
engine proves against a simulator counterexample, the verdict unchanged
with a note when an engine fell short). Nothing here spawns an engine.

**The reader** (`@eutaxy/prover/reader`, a subpath so workerd never loads
it). `readSpecs` reads a module and its spec file: the exported functions
and their parameter types (`function` declarations and `const` arrows,
through `readType`, which reads primitives, literals, `null`, type
literals, the module's `interface` and `type` declarations with type
parameters substituted, unions of them, and arrays of any of them (`T[]`,
`readonly T[]`, `Array<T>`, `ReadonlyArray<T>`), and marks the rest
`unknown`),
every `export const name = forall(f, { when, ensures })` and `total(f)`
with the combinators imported from `eutaxy/spec` and `f` from the module,
the arrows kept as text, and the precondition's conjuncts about one
parameter as that binder's hint (`hintsOf`). `readSubset` and
`readExpression` read the subset every first-party engine translates:
exported functions over `number`, `boolean` and `string` (string-literal
unions read as string), the module's record types, nullable types and
tagged unions declared as aliases, returning any of those, with `const`,
`if` and early returns, `+ - *`, `+` joining strings, comparisons,
`=== !==` (against `null` too, which narrows the tested name where the
check holds: `narrow` nodes, `insertNarrows`, `narrowsOf`), `&& || !`, the
conditional operator, `Number.isInteger`, string and record literals,
field reads (a union's tag) and calls to the module's own functions; a
function outside it, or calling one, is reported with the construct and
the line, and the rest of the module still goes through. `fits` is the
subset's assignability (a member where its union is, `null` or the inner
type where a nullable is); `restrictModule` is the module as an engine
that takes fewer types sees it. `readArrowBody` reads a spec file's arrow
(expression or block body) in a scope of binder types, `renameVars`
renames its parameters to the binders', `typeOf` types an expression.
`tokenize` is the TypeScript-shaped tokenizer under all of it.

**May import.** `@eutaxy/core`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.5 (`CHECKED`), v0.6 (`TESTED`, `PROVEN`, aggregation), v0.7 (the reader, typed binders). See `docs/design.md` and `docs/roadmap.md`.
