# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.8 — Self-check (current)

v0.4 (the simulator), v0.5 (Durable Objects and specs), v0.6 (provers:
the `TESTED` rung, the first-party `prover-lean` engine with its contract
corpus and translation validation, the `Prover` interface, the `PROVEN`
rung and the aggregation across engines) and v0.7 (specs in TypeScript,
the `prover-smt` engine over Z3 with doubles, code-unit strings and
replayed models, and nullable types and tagged unions in the subset
reader) are done; the design describes what they built. The v0.7 gate
holds in CI: the contract corpus's entries with a record parameter, a
nullable record, a union of string literals and a tagged-union result
reach `TESTED` and are `PROVEN` by the SMT engine, a planted false claim
among them is `REFUTED` with a replayed counterexample, the refund
example is `PROVEN` by both engines, and a claim that holds over the
integers and fails over doubles ends `CONFLICT`.

The exhaustive enumerator proven through a model; invariant checkers
verified against reference implementations; `eutaxy report`. The
enumerator in `engine` is a stateful walk over a tree of choices that
runs discover, which no engine translates, so the claim is split where it
can be checked: a pure model in `core` (the schedules of a choice tree)
is proved, and the enumerator is held to the model on every choice tree
up to a size bound by `engine`'s tests. The Lean engine learns what the
model's proofs need: lists, structural recursion, and proofs supplied
beside the spec file (a `.lean` file the kernel checks) where its own
tactic script cannot close a goal. Nullable types and tagged unions in
Lean (structures, inductives, `Option`) come on the way where the core's
specs use them.

**Gate:** Eutaxy's own `eutaxy report` on its core shows `PROVEN` for the
enumerator's model (the number of schedules is the product of the
choices, and no schedule repeats) and `CHECKED` or better for every
invariant checker; `engine`'s tests hold the enumerator to the model.

Patch work alongside, each when a target needs it, shipping as `0.7.x`
until the gate passes:
- The reader moves to the TypeScript 7.1 API once 7.1 is stable (planned
  for 2026-11-24), as a peer dependency of `prover`; `spec` and `core`
  keep importing nothing.
- Widening the engines' subset one corpus entry at a time: structural
  recursion (Lean), narrowing by a union's tag, arrays; the proof cache
  keyed by source, spec and engine version; `eutaxy prover install lean`
  and `… smt`.
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
