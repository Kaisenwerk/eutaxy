# @eutaxy/prover-lean

**Purpose.** Eutaxy's first-party engine: a pure TypeScript subset to Lean 4,
one tactic script, translation validation. Runs on the Node side, over a
process boundary: nothing here is loaded into workerd.

**Public surface.** `leanProver` (the engine as a `Prover`: `available` when
the pinned toolchain is installed, `prove` is `proveModule`); `leanTakes` (the subset types this engine translates: lists of what it takes are among them, as `List`; nullable types and unions are not yet, and a function using them is `unsupported`); structural recursion on a list is emitted as a match on `[]` and `head :: tail`; supplied proofs (`supplied.ts`: `readSupplied`, `axiomsOf`, `standardAxioms`): a `domain.props.lean` beside the spec file, found through `specPath`, whose `-- proof: <property>` sections prove the statements Eutaxy fixes as definitions before them, accepted only when `#print axioms` stays within Lean's standard axioms; `proveModule` (a module's properties, read with its spec file, through
the subset reader, the emitter and the pinned Lean; one Lean run per module,
errors mapped to theorems by line; `PROVEN` with engine name, version and
assumptions, or `UNKNOWN` as `gave_up` when a proof does not close or Lean
times out, `unsupported` when a function or property is outside the subset,
`unavailable` when the pinned toolchain is not installed; `total` is proved
by Lean accepting the definition); `prepare` (read and emit without running
Lean); the subset reader re-exported from `@eutaxy/prover/reader`, where it
lives so that every first-party engine reads the same tree; `emitModule`, `statement`, `value` and
`ident` (the Lean text: `f_` functions, `R_` records, `v_` variables, `t_`
theorems, so nothing collides with Lean's prelude or with another kind of
name); `findLean`, `checkLean`,
`diagnostics`, `leanToolchain`, `leanVersion`, `installHint`.

**Toolchain.** Pinned to `leanToolchain` in `src/lean.ts`, found through
`elan` (only when it already has that release: nothing is downloaded during
a check) or a bare `lean` of exactly that version. The contract corpus in
`corpus/prover-contracts` is what the subset means; CI installs the pinned
toolchain and runs it with `EUTAXY_REQUIRE_LEAN=1`.

**May import.** `@eutaxy/prover`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.6. See `docs/design.md` and `docs/roadmap.md`.
