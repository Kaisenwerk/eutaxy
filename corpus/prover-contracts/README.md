# Prover contracts

Functions with known verdicts for the first-party Lean engine
(`packages/prover-lean`): what it must prove, where it must give up, and
what it must refuse as outside its subset. Each entry is one annotated
module, `domain.ts`, and a `manifest.json` naming the expected outcome of
every property (`PROVEN`, `gave_up`, `unsupported`). `harness.test.ts`
runs the engine on every entry against the pinned Lean toolchain and also
validates the translation: the emitted Lean definitions must compute what
the TypeScript computes on inputs drawn from each function's parameter
types. The subset is specified by this corpus; it widens one entry at a
time.

The harness needs the pinned toolchain (`leanToolchain` in
`packages/prover-lean/src/lean.ts`). Without it the tests are skipped
locally and fail in CI, where `EUTAXY_REQUIRE_LEAN=1` is set.
