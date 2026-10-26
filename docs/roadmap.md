# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.7 — TypeScript specs and the SMT engine (current)

v0.4 (the simulator), v0.5 (Durable Objects and specs) and v0.6 (provers:
the `TESTED` rung, the first-party `prover-lean` engine on its initial
subset with its contract corpus and translation validation, the `Prover`
interface, the `PROVEN` rung in `eutaxy check --prover lean` and the
aggregation across engines) are done; the design describes what they
built.

v0.7 changes the spec surface and adds a second engine. The first real
core signatures a target sent (a record parameter, a nullable record, a
union of string literals, a tagged result) fit no Lemma binder, and
widening Lemma would have meant forking it; with specs in TypeScript the
binders are the parameter types. In this order:
- Done: specs in TypeScript (`forall(f, { when, ensures })`, `total(f)`, in
  a spec file beside the module), read into `SpecIR` with typed binders by
  the hand-written reader; `CHECKED` and `TESTED` over records, nullable
  types, unions of literals and tagged unions. Breaking: Lemma annotations
  are dropped, with a migration note in the changelog. A breaking change
  cannot ship as a patch, so nothing ships between it and `0.7.0`.
- `prover-smt`: the subset to SMT-LIB 2, Z3 pinned and resource-limited;
  doubles, code-unit strings, datatypes; every model replayed on the real
  function before `REFUTED`; its contract corpus shared with Lean's, with
  one entry that holds over the integers and fails over doubles and must
  end `CONFLICT`.
- The Lean engine takes the same typed binders (structures, inductives,
  `Option`), after the SMT engine has them.
- The reader moves to the TypeScript 7.1 API once 7.1 is stable (planned
  for 2026-11-24), as a peer dependency of `prover`; `spec` and `core`
  keep importing nothing.

**Gate:** in CI, corpus entries with a record parameter, a nullable
record, a union of string literals and a tagged-union result reach
`TESTED` and are `PROVEN` by the SMT engine; a planted false claim among
them is `REFUTED` with a replayed counterexample; the refund example is
`PROVEN` by both engines; the integer-versus-double entry ends `CONFLICT`.

Patch work alongside, each when a target needs it, shipping as `0.7.x`
once the gate has passed:
- Widening the engines' subset one corpus entry at a time: structural
  recursion (Lean), arrays, wider unions; the proof cache keyed by source,
  spec and engine version; `eutaxy prover install lean` and `… smt`.
- A configurable number of `TESTED` draws on the command line (the API
  takes `inputs`).
- MCP server and GitHub Action over the JSON schema.
- Optional Thales and LemmaScript adapters with their own contract corpora,
  each generating its engine's syntax from `SpecIR`, which is what
  `CONFLICT` is also for.
- Left over from v0.5: concurrent delivery on the AWS platform (it still
  delivers one event at a time); latency on scripted externals; Workers KV,
  and Durable Object SQL storage (objects use key-value storage so far);
  dynamic partial-order reduction if real scenarios lose the sleep-set
  reduction too often; Workflows beyond the model (`waitForEvent` and
  `sendEvent`, step timeouts in virtual time, `createBatch`, rollback
  handlers, pausing and terminating instances); one random stream per
  invocation, when a shrunk violation that keeps extra events gets in a
  target's way (randomness is one stream per run, so dropping an earlier
  event shifts the random ids drawn after it, and a violation keyed on them
  cannot shrink past it; fault positions are already per invocation; every
  committed trace changes with it).

`0.6.0` removed `checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and
`ModulePredicates` from the public facade (internal to `eutaxy check` since
`0.5.1`) and `QueueHandler` from `eutaxy/cloudflare` (the former name of
`WorkerHandler`), all deprecated through `0.5.x`. `observeCore` stays
public: a user's own test needs it to give `refines` its decisions, and
generated regression tests import it.

## v0.8 — Self-check

Enumerator proven through a prover adapter; invariant checkers verified
against reference implementations; `eutaxy report`.

**Gate:** Eutaxy's own `eutaxy report` on its core shows `PROVEN` for the
enumerator and `CHECKED` or better for every invariant checker.

## Long-term direction

Eutaxy stays a tool that runs real code; it never asks for a model of the
system beside the code. The direction is to let the verdicts about that
code climb, in steps each verdict states.
- **The platform model is the shared model.** The simulator executes
  Eutaxy's model of queues, Durable Objects, D1 and alarms, and the
  differential corpus holds it to workerd. The same model gets a formal
  form, validated against the executable one as the Lean engine's
  translation is validated today, so a scenario invariant can be proven
  for the shell against it, not only explored. The user's code and
  Eutaxy's model are the whole system; nobody writes a second one.
- **Scenario verdicts climb the ladder specs climb.** `BOUNDED` means no
  violation within stated bounds. A reduction proven complete makes it
  exhaustive within them; a proven property of the code, such as a
  handler's idempotence, justifies the bound itself; a scenario reaches
  `PROVEN` by such steps, each named in the verdict, never by fiat.
- **Verdicts a coding agent can act on.** Verdicts depend only on files in
  the repository, counterexamples come back as replayable regression tests,
  and a proof an engine cannot find can be supplied and is checked by the
  kernel, so the loop "check, read the report, fix or prove, check again"
  needs nobody in it and CI is the referee.
- **Self-check anchors the trust.** v0.8 proves Eutaxy's own enumerator
  and invariant checkers, the first pieces of the platform model to be
  proven.

Liveness and temporal properties wait for a target that needs them; the
bounded form ("every message is acknowledged within the redelivery bound")
fits the ladder when one does.
