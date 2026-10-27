# Prover contracts

Functions with known verdicts for the first-party engines
(`packages/prover-lean`, `packages/prover-smt`): what each must prove,
refute or give up on, and what it must refuse as outside its subset. Each
entry is one module, `domain.ts`, its spec file, `domain.props.ts`, and a
`manifest.json` naming the expected outcome of every property per engine
(`PROVEN`, `REFUTED`, `gave_up`, `unsupported`). The two columns differ
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
