# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.5.x (current)

v0.4 (the simulator) and v0.5 (Durable Objects and specs) are done; the
design describes what they built. Patch work has no gate of its own: each
item ships as a `0.5.x` release once `pnpm check` and the corpora pass,
and v0.6's gate closes the next phase.

In this order. The first two came out of a full review before 0.5.0 and
go before the provers, because the prover phase builds on the engine's run
loop and the public facade, which are cheaper to reshape now than after.
- Oversized modules split along their seams: `engine/run.ts` into the
  effect protocol, frames and the concurrent scheduler;
  `cloudflare/platform.ts` into HTTP and queue delivery beside `alarms.ts`;
  `core/invariants.ts` into selectors, state invariants and `refines`.
- Smaller simplifications: one token check shared by the spec parser's
  atoms and template substitutions; unused core exports dropped; per-package
  nits.
- Left over from v0.5, when a target needs them: concurrent delivery on
  the AWS platform (it still delivers one event at a time); latency on
  scripted externals; Workers KV, and Durable Object SQL storage (objects
  use key-value storage so far);
  dynamic partial-order reduction if real scenarios lose the sleep-set
  reduction too often.
- R2 and Workflows models.

## v0.6 — Provers (next)

- `TESTED` rung; `Prover` interface, ladder and aggregation.
- First-party `prover-lean` engine on the initial subset (immutable data,
  algebraic types, structural recursion, bounded integers, quantifier-free
  arithmetic), with its contract corpus and translation validation; proof
  cache; `eutaxy prover install lean`.
- MCP server and GitHub Action over the JSON schema.

`checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and `ModulePredicates`
leave the public facade with `0.6.0`. They are deprecated in `0.5.x`,
since the check test `eutaxy check` generates now holds only its module
globs and one call to `checkInWorkerd`, so nothing generated imports them;
removing them in a patch release would break callers semver lets rely on
them. `observeCore` stays public: a user's own test needs it to give
`refines` its decisions, and generated regression tests import it.

**Gate:** the first-party contract corpus passes against the pinned Lean
toolchain; the refund example reaches `PROVEN` with the first-party engine.

### v0.6.x

Optional Thales and LemmaScript adapters with their own contract corpora;
`CONFLICT` detection across engines.

## v0.7 — Self-check

Enumerator proven through a prover adapter; invariant checkers verified
against reference implementations; `eutaxy report`.

**Gate:** Eutaxy's own `eutaxy report` on its core shows `PROVEN` for the
enumerator and `CHECKED` or better for every invariant checker.
