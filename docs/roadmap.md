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

In this order.
- Left over from v0.5, when a target needs them: concurrent delivery on
  the AWS platform (it still delivers one event at a time); latency on
  scripted externals; Workers KV, and Durable Object SQL storage (objects
  use key-value storage so far);
  dynamic partial-order reduction if real scenarios lose the sleep-set
  reduction too often.
- Workflows, beyond the model (`waitForEvent` and `sendEvent`, step
  timeouts measured in virtual time with latency on scripted externals,
  `createBatch`, rollback handlers, pausing and terminating instances),
  when a target needs them.
- One random stream per invocation, when a shrunk violation that keeps
  extra events gets in a target's way: randomness is one stream per run,
  so dropping an earlier event shifts the random ids drawn after it, and a
  violation keyed on them cannot shrink past it. Fault positions are
  already per invocation; every committed trace changes with it.

## v0.6 — Provers (next)

The `TESTED` rung and the ladder up to it (`CHECKED`, then `TESTED`) are
done; the design describes them. The `PROVEN` rung runs where an engine can
be spawned, on the Node side of `eutaxy check`, not inside workerd, which is
where the first two rungs run.
- `Prover` interface shaped by the first engine, the `PROVEN` rung on the
  ladder, aggregation across engines (`CONFLICT`).
- First-party `prover-lean` engine on the initial subset (immutable data,
  algebraic types, structural recursion, bounded integers, quantifier-free
  arithmetic), with its contract corpus and translation validation; proof
  cache; `eutaxy prover install lean`.
- MCP server and GitHub Action over the JSON schema.
- When a target needs them: `TESTED` draws for record and tagged-union
  binders, once Lemma or an Eutaxy extension has such domains; a
  configurable number of draws on the command line (the API takes
  `inputs`).

`checkSpecModule`, `lemmaBool`, `lemmaUnresolved`, `ModulePredicates` and
`QueueHandler` (the former name of `WorkerHandler`) leave the public facade
with `0.6.0`. They are deprecated in `0.5.x`,
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
