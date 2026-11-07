# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## As of now

The phases through v0.15 are done; `docs/design.md` describes what they
built, and each phase's gate keeps running in CI on every change.
- **v0.4, the simulator.** A Worker's queue consumer run under explored
  schedules: faults at every effect, redelivery as Cloudflare Queues
  does, invariants over the effect log, shrinking, a regression test per
  violation, and traces that repeat byte for byte from a seed.
- **v0.5, Durable Objects and specs.** Durable Objects as the real
  objects workerd runs, with their alarms in virtual time, and spec files
  beside the pure core.
- **v0.6, provers.** The `TESTED` rung, the first-party `prover-lean`
  engine with its contract corpus and translation validation, the
  `Prover` interface, the `PROVEN` rung and the aggregation across
  engines.
- **v0.7, specs in TypeScript.** The `prover-smt` engine over Z3 with
  doubles, code-unit strings and replayed models, and nullable types and
  tagged unions in the subset reader.
- **v0.8, the self-check.** `eutaxy report`, arrays and lists in the
  subset, structural recursion in Lean, proofs supplied beside the spec
  file and checked by the kernel, the invariant checkers held to naive
  references, the enumeration model proven and the enumerator held to it.
- **v0.9, the reader on the compiler.** Binder types and the subset's
  types are what the user's TypeScript compiler resolves: generic aliases
  instantiated, inline object types, aliases declared later, record
  literals told apart by their declared return type, types imported from
  other files, narrowing by a union's tag.
- **v0.10, one Worker of a system.** How a run chooses is one `Chooser`
  for faults and turns, and each binding one record the platform and the
  differential runner iterate. An RPC drive resent under the caller's
  policy, service bindings answered from scripted replies, a cron drive
  on the virtual clock, and `step.waitForEvent` with `sendEvent`. Gate: a
  Worker driven over RPC and by cron, calling a scripted Worker and
  handing orders to a Workflow that waits for its event, runs with no
  `UNSUPPORTED` verdict.
- **v0.11, the provers installed.** `eutaxy prover install lean` and
  `… smt`: each engine's pinned upstream release, checksum-verified before
  it is unpacked, into a cache the engines look in first, or from a mirror
  or offline copy. Gate: the `check` workflow installs both with the
  command and the contract corpus passes on them.
- **v0.12, the agent loop.** `eutaxy mcp`, a Model Context Protocol
  server over stdio in both protocol eras, whose tools return the JSON
  report; goal files, the Lean engine's open goals written beside the
  spec file, stale once the module or the spec changes. Gate: over stdio,
  a check to a violation and its regression test, and open goals to a
  supplied proof to `PROVEN`, then stale once the module changes.
- **v0.13, Durable Objects on SQLite, and Agents.** The `durableObject`
  step resets, seeds and snapshots SQL tables beside key-value rows, and
  state invariants read them as they read D1. An Agents SDK class runs as
  written: its state, `this.sql`, schedules over the object's alarm, and
  WebSocket connections as events (`websocket` drive) delivered to its
  `webSocketMessage`, with what it sends recorded per connection. Gate:
  an Agent with a schedule and WebSocket connections, and other objects on
  SQLite, run with no `UNSUPPORTED` verdict, and a planted bug in an
  object's SQL rows is caught.
- **v0.14, the system.** The Worker behind a service binding runs for
  real in its caller's simulation (`callee()`): the call is an effect
  hosting the callee's invocation, a fault can land on either side, the
  callee's bindings are qualified by its Worker's name, shared resources
  are one resource, nested callees and a callee's Workflows run, and
  `eutaxy check` builds the isolate from both wrangler configs. Gate: two
  Workers' real code in one scenario with no `UNSUPPORTED` verdict, and a
  planted bug across them caught where the same scenario with the callee
  scripted is `BOUNDED`.
- **v0.15, worked examples, and the first scenario in minutes.** Six
  examples, each a Worker, its scenario, the bug it catches and the fix,
  checked through the command and shown on the site: a queue consumer
  over D1, a webhook with an idempotency key, a lease pool object with an
  alarm, an Agent with a schedule and WebSockets, two Workers over a
  service binding, a Workflow waiting for an event. `eutaxy draft` (a
  command and an MCP tool) writes a scenario from a wrangler config, with
  the invariants and events left as holes. The site gained a reference
  page per entry point, generated from the source with a doc comment on
  every public name, the catalogue of `UNSUPPORTED` reasons, and a page on
  Eutaxy next to its neighbours. Writing the examples also made `eutaxy
  check` run the scenario's own entry and wrangler config. Gate: every
  example green through the command, each draft matching its example in
  everything the author does not supply, and the site built with a page
  per example and per entry point.

Notes on releases along the way:
- `0.9.0` needs TypeScript 7.1 in the project (`typescript@7.1.0-beta`
  until the release on 2026-11-24, then the release): the spec reader runs
  the project's compiler. The reader follows the compiler's own releases
  (the beta, the release candidate on 2026-11-10, the release) and is
  pinned to each in turn. `readSpecs` takes the module's path
  (`modulePath`, and `specPath`) in place of the import specifiers it used
  to match by; the import is resolved by the compiler.
- `0.6.0` removed `checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and
  `ModulePredicates` from the public facade (internal to `eutaxy check` since
  `0.5.1`) and `QueueHandler` from `eutaxy/cloudflare` (the former name of
  `WorkerHandler`), all deprecated through `0.5.x`. `observeCore` stays
  public: a user's own test needs it to give `refines` its decisions, and
  generated regression tests import it.

## Patch work after v0.15

Until the next phase opens, work ships as `0.15.x`: the following, each
when a target needs it (the performance items and the proof cache are
v0.16's and wait for it unless a target needs one sooner):
- A configurable number of `TESTED` draws on the command line (the API
  takes `inputs`).
- The command loads the spec reader and the engines only where specs are
  read or proved, so the TypeScript compiler becomes an optional peer
  (today `eutaxy/cloudflare` loads without it inside Vitest, but the
  command needs it from its first line).
- An audit of supplied proofs from outside the Lean process that
  elaborated them (a compiled checker over the `.olean`, replaying the
  kernel), when a target checks proofs its own repository did not write;
  today a proof file is trusted as the spec file beside it is.
- A GitHub Action over the JSON schema.
- The documentation site at eutaxy.dev (`site/`, VitePress, deployed to
  GitHub Pages by the `pages` workflow) is kept current with every change,
  outside the phases because it changes no behaviour; `docs/design.md` and
  this roadmap are included in it verbatim, so they stay the one record of
  what is decided.
- The `UNSUPPORTED` reasons that close with little model work (the site's
  catalogue of reasons lists them all): an R2 object's upload time on the
  virtual clock, so `onlyIf` conditions on it are modelled; alarm calls
  inside `transactionSync()`, applied at its commit; the AWS SDK's
  callback form of `send`, as the promise form; and Workflow instance
  management, `terminate()`, `pause()`, `resume()`, `restart()`,
  `createBatch()` and `deleteBatch()`, as the engine documents them.
- Left over from earlier phases: concurrent delivery on the AWS platform
  (it still delivers one event at a time); latency on scripted externals;
  Workflow rollback handlers. Dynamic partial-order reduction and one
  random stream per invocation are v0.16's.

## After v0.15

Each phase's text is made exact, gate included, when it starts.

### Next: what an adopter's flows across Workers need

Two model features a real multi-Worker system reached first, ahead of
v0.16 unless that system's needs change, since a flow it checks waits on
them:
- **Work an object starts and does not await.** A Durable Object (an
  Agent in particular) that answers a call and goes on with work it did
  not await, through `ctx.waitUntil`, a fiber or a promise left running:
  today that work outlives the call's effect and the run is
  `UNSUPPORTED`. The model runs it as the object's own turns after the
  answer, with its effects and faults, until it settles or the object is
  evicted.
- **A step attempt that outlives its timeout.** Workflows retries a step
  whose attempt passed its `timeout` while that attempt may still be
  running; today an attempt runs to its end before the retry, so a race
  between the late attempt and the retry, or the code that recovers from
  it, is never explored. The model measures step timeouts and lets the
  timed-out attempt run on as a concurrent turn.

### Candidates: the larger gaps in the model

The `UNSUPPORTED` reasons that need model work of their own, most useful
first. Each waits until a target's code reaches it rather than being
built for coverage, and each becomes a phase, or joins one, with a gate
when it does:
- **Calls between Durable Objects.** One object calling another through
  its own `env` ends the run today; the call becomes an effect hosting
  the second object's turn, with the faults a stub call has.
- **Workers KV.** The most used binding the simulation does not proxy.
  KV is eventually consistent, so the model explores reads that see an
  older value within the documented propagation window, which is where
  KV bugs live.
- **Queue producers.** A `send()` feeds the scenario's own consumer of
  that queue, so a chain of producing and consuming Workers is checked
  end to end.
- **A scripted binding for request-and-answer bindings** (Workers AI,
  Vectorize, Images and the like), answered from the scenario as
  `service()` answers a service binding.
- **Later:** RPC promise pipelining and capabilities (stubs returned,
  functions passed); the standard WebSocket API and auto-responses; D1
  sessions; R2 multipart uploads; constructors that read the alarm, as an
  Agents SDK class does; steps run in parallel with a wait.

Some reasons stay by design: the replay and leak checks (`not_replayable`,
`module_state_leak`) are what make a verdict trustworthy, and work Eutaxy
cannot see (a promise nothing settles, real I/O past the budget, a raw TCP
socket) is reported rather than guessed. The leak check could fire less
often with fresh module state per run, at a cost in speed that is
v0.16's to weigh.

### v0.16 — Runs that scale

The time a check and a report take, as scenarios and spec modules grow:
the engines' modules in parallel, the proof cache keyed by source, spec
and engine version; and the engine items a growing scenario
meets: one random stream per invocation, so a shrunk violation gets past
the random ids an earlier event drew, and dynamic partial-order reduction
where the sleep-set reduction loses too often. The gate states a ceiling
on the corpora's check and report time on the CI runner and holds it.

### v0.17 — The model proven

The first step of the long-term direction: the platform model of queues,
Durable Objects, D1 and alarms in Lean, validated against the executable
model as the engine's translation is validated today, so a scenario
invariant on the shell can be `PROVEN` against the model, not only
`BOUNDED` by exploration. It waits for v0.15 and v0.16 because it needs
the semantics stable and the runs fast enough to validate against.

## Toward 1.0

`1.0.0` is the release after which the public API changes only with a
major version. It is cut on four conditions, each checkable, none a date:
- A production system of several Workers runs its scenarios under Eutaxy
  in its own CI for weeks with no `UNSUPPORTED` surprise: the second
  concrete use the design rules ask for.
- A reader new to Eutaxy writes a passing scenario for a Worker of their
  own from the documentation alone, which v0.15 exists to make true.
- The public API, the platform options and the JSON report schema have
  held still for three minor releases, deprecated aliases removed and a
  migration page written.
- CI has been green twenty consecutive runs with no retry: a flake is a
  bug to understand first.

When a target needs them, outside any phase: an email binding with a
recorded outbox, containers as a scripted external, and Durable Object to
Durable Object calls. AWS gets nothing new until a target uses it.

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
