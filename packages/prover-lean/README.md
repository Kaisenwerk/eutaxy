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
name); `renderGoals`, `goalFileFor` and `proofFileFor` (the goal file: a module's open goals, each `forall` property the tactic script gave up on with the statement it emitted, which `proveModule` lists as `goals`, rendered in the form of the proof file with every proof open and two header lines naming the SHA-256 of the module and of the spec file; `sourceHashMarker`, `specHashMarker`; a proof file carrying them is stale once either changed, refused with the reason, so its properties are `gave_up`, never `PROVEN`); `readSupplied`, `refusedIn`, `axiomsOf`, `standardAxioms`; `findLean`, `checkLean`,
`diagnostics`, `leanToolchain`, `leanVersion`, `installHint`; and from
`src/elan.ts`, what `eutaxy prover install lean` and the engine share:
`elanDownloads` (elan's pinned installer per platform, with its checksum
and the one file taken from it), `elanVersion`, `elanHome` (Eutaxy's own
elan, `<cache>/elan`), `elanCandidates` (Eutaxy's elan, then the `PATH`,
then `ELAN_HOME` or `~/.elan`), `leanDigests` and `toolchainDigest` (the
digest of every file and link under a toolchain's directory, pinned per
platform, which the command checks after elan installed the toolchain).

**Toolchain.** Pinned to `leanToolchain` in `src/lean.ts`, found through
elan, asked for it by name: the first of `elanCandidates` that already has
that release (nothing is downloaded during a check; Eutaxy's own elan runs
with its `ELAN_HOME`), then as a bare `lean` of exactly that version.
The contract corpus in `corpus/prover-contracts` is what the subset means;
CI installs the pinned toolchain with the command and runs it with
`EUTAXY_REQUIRE_LEAN=1`.

**May import.** `@eutaxy/prover`, `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.6; v0.12 (goal files, stale proofs). See `docs/design.md` and `docs/roadmap.md`.
