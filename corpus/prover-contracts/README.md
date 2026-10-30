# Prover contracts

Functions with known verdicts for the first-party engines
(`packages/prover-lean`, `packages/prover-smt`): what each must prove,
refute or give up on, and what it must refuse as outside its subset. Each
entry is one module, `domain.ts`, its spec file, `domain.props.ts`, and a
`manifest.json` naming the expected outcome of every property per engine
(`PROVEN`, `REFUTED`, `gave_up`, `unsupported`) and the constructs it
`covers`.

Entries come in two kinds. `constructs/<name>` exercises one thing the
subset takes, or one it refuses, in as small a module as shows it.
`shapes/<name>` is a realistic decision that combines several, the way
real code does. `constructs.json` is the vocabulary: every construct, what
it is, and whether each engine takes it (`in`) or reports it
`unsupported` (`out`). `coverage.test.ts` keeps the vocabulary and the
entries together: every entry covers named constructs, every construct
has an entry under `constructs/`, and each engine's `in` or `out` shows in
the outcomes the covering entries expect. A construct joins the subset
with its entry and its line in the vocabulary, in the same change. The two columns differ
where a claim holds over the integers, which the Lean engine models, and
fails over doubles (`NaN`, the infinities, `-0`), which the SMT engine
models and refutes with a replayed counterexample. `harness.test.ts`
runs both engines on every entry against the pinned Lean and Z3 and also
validates each translation: the emitted definitions must compute what the
TypeScript computes on inputs drawn from each function's parameter
types. The subset is specified by this corpus; it widens one entry at a
time.

The harness needs the pinned toolchain (`leanToolchain` in
`packages/prover-lean/src/lean.ts`). Without it the tests are skipped
locally and fail in CI, where `EUTAXY_REQUIRE_LEAN=1` is set.
