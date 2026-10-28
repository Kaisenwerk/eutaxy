# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.9 — Specs over real signatures (current)

v0.4 (the simulator), v0.5 (Durable Objects and specs), v0.6 (provers:
the `TESTED` rung, the first-party `prover-lean` engine with its contract
corpus and translation validation, the `Prover` interface, the `PROVEN`
rung and the aggregation across engines), v0.7 (specs in TypeScript, the
`prover-smt` engine over Z3 with doubles, code-unit strings and replayed
models, and nullable types and tagged unions in the subset reader) and
v0.8 (the self-check: `eutaxy report`, arrays and lists in the subset,
structural recursion in Lean, proofs supplied beside the spec file and
checked by the kernel, the invariant checkers held to naive references,
the enumeration model proven and the enumerator held to it) are done; the
design describes what they built. The v0.8 gate holds in CI: `eutaxy
report` on `packages/core/src` shows `PROVEN` for the enumeration model's
count, no-repeat and in-bounds claims, `CHECKED` or better for every
invariant checker, sixteen planted bugs in copies of the core are each
`REFUTED`, and `engine`'s tests hold the enumerator to the model on every
choice tree up to depth four and width three.

The reader moves to the TypeScript 7.1 API. Real core signatures use what
the hand-written reader refuses: generic type aliases, inline object
types, an alias declared later in the file, a record literal that only the
declared return type tells apart from another alias of the same shape,
and types imported from other files. 7.1's API (`typescript/sync`,
`typescript/ast`, its checker) resolves all of these, so the reader stops
parsing TypeScript and asks the user's compiler instead: the compiler
becomes a peer dependency of `prover`, as Vitest is of the facade, and
`spec` and `core` keep importing nothing. What stays Eutaxy's is the
subset's meaning: its integers and doubles, its list model, narrowing,
structural recursion, and the expression tree the engines translate; the
engines never touch the compiler API, so the reader is one module to
replace and the one place a compiler change lands. The work starts on the
7.1 beta pinned exactly and follows it to the release candidate
(2026-11-10) and the release (2026-11-24), so that a release of Eutaxy
carrying the new reader needs 7.1 on the user's side. Narrowing by a
union's tag comes with it, since the reader then sees what the checker
narrows.

**Gate:** every contract-corpus entry and every corpus core reads through
the compiler API with the same verdicts as before, and the five signature
shapes above, each a contract entry, reach `TESTED` and are `PROVEN` by
the SMT engine where it decides them.

Patch work alongside, each when a target needs it, shipping as `0.8.x`
until the gate passes:
- The concurrent scheduler woken by progress rather than by real
  zero-timers (a run with two invocations in flight costs three to four
  times its I/O today, since a zero timer is about a millisecond in
  workerd); `report`'s module workers and the engines' modules run in
  parallel, toolchain lookups once per process, one Z3 prelude per module.
- The proof cache keyed by source, spec and engine version; `eutaxy prover
  install lean` and `… smt`.
- A configurable number of `TESTED` draws on the command line (the API
  takes `inputs`).
- An audit of supplied proofs from outside the Lean process that
  elaborated them (a compiled checker over the `.olean`, replaying the
  kernel), when a target checks proofs its own repository did not write;
  today a proof file is trusted as the spec file beside it is.
- MCP server and GitHub Action over the JSON schema.
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
- **Self-check anchors the trust.** v0.8 proved Eutaxy's own enumeration
  model and held its invariant checkers to references, the first pieces
  of the platform model to be verified; the rest of the model follows the
  same way.

Liveness and temporal properties wait for a target that needs them; the
bounded form ("every message is acknowledged within the redelivery bound")
fits the ladder when one does.
