# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.9 — Specs over real signatures (done)

v0.4 (the simulator), v0.5 (Durable Objects and specs), v0.6 (provers:
the `TESTED` rung, the first-party `prover-lean` engine with its contract
corpus and translation validation, the `Prover` interface, the `PROVEN`
rung and the aggregation across engines), v0.7 (specs in TypeScript, the
`prover-smt` engine over Z3 with doubles, code-unit strings and replayed
models, and nullable types and tagged unions in the subset reader), v0.8
(the self-check: `eutaxy report`, arrays and lists in the subset,
structural recursion in Lean, proofs supplied beside the spec file and
checked by the kernel, the invariant checkers held to naive references,
the enumeration model proven and the enumerator held to it) and v0.9
(the reader on the TypeScript compiler's API: binder types and the
subset's types are what the user's compiler resolves, so generic aliases
instantiated, inline object types, an alias declared later in the file,
a record literal told apart by its declared return type and types
imported from other files all read; narrowing by a union's tag) are
done; the design describes what they built. The v0.9 gate: every
contract-corpus entry and every corpus core reads through the compiler
API with the verdicts it had, and five contract entries, one per
signature shape above, reach `TESTED` and are `PROVEN` by the SMT engine
where it decides them, two of them through a tag test that narrows the
union in the function and in the claim.

`0.9.0` needs TypeScript 7.1 in the project (`typescript@7.1.0-beta`
until the release on 2026-11-24, then the release): the spec reader runs
the project's compiler. The reader follows the compiler's own releases
(the beta, the release candidate on 2026-11-10, the release) and is
pinned to each in turn. `readSpecs` takes the module's path
(`modulePath`, and `specPath`) in place of the import specifiers it used
to match by; the import is resolved by the compiler.

## v0.10 — Workers that call each other (current)

The target is a system of Workers split by business context, which talk
to each other through service bindings and `WorkerEntrypoint` RPC, run on
cron triggers, and hand long work to Workflows that wait for events. In
0.9 each of those makes a run `UNSUPPORTED`. v0.10 makes one Worker of
such a system checkable on its own, with the Workers it calls scripted;
running the callee's real code in the same simulation is later work,
which these scripted boundaries teach.

It opens with a refactor, paid before the new bindings land, since each
new binding would otherwise repeat what the existing ones repeat:
- How a run chooses becomes one object: the exhaustive enumerator's
  `Chooser`, with seeded, replay and exhaustive implementations built once
  in `explore`, decides faults and turns alike, and the fault ladder each
  kind of effect repeats is written once.
- Each binding becomes one record (proxy, reset, snapshot) that the
  platform and the differential runner both iterate, around one delivery
  skeleton, with the redelivery rule as one pure function in `core` that
  the simulated and raw sides share.

Behaviour does not change: every corpus verdict and every committed
regression trace stays byte-identical across the refactor.

Then the boundaries, each following the Cloudflare documentation it cites:
- **Inbound RPC.** A drive that calls a `WorkerEntrypoint` method as an
  event, its return value recorded as the response effect. Cloudflare
  does not retry an RPC call, so resends follow a declared caller policy,
  as the HTTP drive's do.
- **Outbound service bindings, callee scripted.** `fetch` and RPC calls
  through a service binding are one effect each, with the fault meanings
  of a Durable Object stub call (`crash_before` and `error`: the call
  never reached the callee; `ambiguous`: it acted and the answer was
  lost), answered from replies the scenario scripts, as externals are.
  Every verdict states that the callee was scripted.
- **Cron.** A drive for the `scheduled` handler, with `scheduledTime` and
  the cron expression from the virtual clock and the scenario.
- **Workflows events.** `step.waitForEvent` and `instance.sendEvent` in
  the Workflows model: an instance waits in virtual time for an event of
  its type, up to its timeout.

The v0.10 gate: scenarios for a Worker that is driven over RPC and by
cron, calls another Worker through a service binding, and sends events
to a Workflow that waits for them run with no `UNSUPPORTED` verdict (the
Worker lives in `corpus/gates/`); each new boundary has a planted bug the
check catches and, where the local runtime implements it, a differential
entry against workerd; and the opening refactor leaves every earlier corpus
verdict and committed trace unchanged.

## Patch work alongside v0.10

Work toward v0.10 ships as `0.9.x`, and so does the following, each when
a target needs it:
- Done first, before the refactor: the gaps a shared result type meets in
  real cores, generic functions (`ok<T>(value: T)`, instantiated from the
  call's resolved signature), calls to functions imported from another
  module of the project, module constants and `Math.floor`, each with a
  contract entry in that shape, so decision functions built on such a
  kit reach `PROVEN` through the SMT engine; and the concurrent scheduler
  woken by progress, taking one turn of the event loop per decision
  rather than two or three, since v0.10's scenarios run concurrently. In
  workerd that turn is a zero timer of about a millisecond, the only way
  to its event loop, so a run with two invocations in flight still costs
  about a millisecond per turn beyond its I/O (the wallet entry went from
  3.4 to 2.3 times its sequential cost per run).
- The remaining performance items: `report`'s module workers and the
  engines' modules run in parallel, toolchain lookups once per process,
  one Z3 prelude per module.
- A report path per run in `eutaxy check`, so two checks of one scenario
  running at once do not share Vitest's report file.
- The proof cache keyed by source, spec and engine version; `eutaxy prover
  install lean` and `… smt`.
- A configurable number of `TESTED` draws on the command line (the API
  takes `inputs`).
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
- Left over from v0.5: concurrent delivery on the AWS platform (it still
  delivers one event at a time); latency on scripted externals; Workers KV,
  and Durable Object SQL storage (objects use key-value storage so far);
  dynamic partial-order reduction if real scenarios lose the sleep-set
  reduction too often; Workflows beyond the model and v0.10 (step timeouts
  in virtual time, `createBatch`, rollback handlers, pausing and
  terminating instances); one random stream per invocation, when a shrunk
  violation that keeps extra events gets in a target's way (randomness is
  one stream per run, so dropping an earlier event shifts the random ids
  drawn after it, and a violation keyed on them cannot shrink past it;
  fault positions are already per invocation; every committed trace
  changes with it).

`0.6.0` removed `checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and
`ModulePredicates` from the public facade (internal to `eutaxy check` since
`0.5.1`) and `QueueHandler` from `eutaxy/cloudflare` (the former name of
`WorkerHandler`), all deprecated through `0.5.x`. `observeCore` stays
public: a user's own test needs it to give `refines` its decisions, and
generated regression tests import it.

## After v0.10

The phases after v0.10, in order. Each is driven by the same target, and
each one's text is made exact, gate included, when it starts.

### First after v0.10 — Prover install

`eutaxy prover install lean` and `eutaxy prover install smt`, as
packaging already describes, so that a user and the target's CI get a
prover with one command instead of installing elan or Z3 by hand. Each
Eutaxy release carries, per platform, the URL and SHA-256 of the
upstream Lean and Z3 release files its engines are pinned to; the command
downloads explicitly (never on install, never during a check), verifies
the checksum, and unpacks into Eutaxy's cache directory, where engines
look first, before elan and the `PATH`. A mirror or offline directory can
replace the download host. Upstream files come first because rebuilding
the toolchains would mean a build matrix and hosting to secure; a trimmed
Lean bundle (the binary and `Init`, which is all the emitted modules
load) is built only if the measured download size calls for it. It comes
first because it is small and every later phase's proofs need a prover
the target can install.

Gate: CI installs both engines with the command instead of its own
install steps and the contract corpus passes on them; a test shows a
checksum mismatch installs nothing.

### v0.11 — The agent loop

An MCP server and goal files for supplied proofs. `eutaxy mcp` is a local
stdio server over the CLI and the JSON report: run a check, read the
report, list the open proof goals, check a proof. Where the tactic script
gives up, the goal is written to a file: the statement Eutaxy generated,
a hash of the source, spec and engine version, and the proof left open.
A proof supplied for it is checked by the Lean kernel as supplied proofs
are today, and one whose statement or hash no longer matches is stale,
never `PROVEN`. Eutaxy itself never calls a model: verdicts depend only on
files in the repository. It comes second because it makes checking the
next Workers cheaper, and it is small.

Gate: an end-to-end test over stdio goes from a check to an open goal to a
supplied proof to `PROVEN`, and a violation comes back through the server
as a replayable regression test.

### v0.12 — Durable Objects on SQLite, and Agents

Durable Object SQLite storage (`ctx.storage.sql`): reset, seeded and
snapshotted table by table, its calls synchronous and held by the input
gate as storage calls are. A class built on the Agents SDK runs as
written, on that storage, with its scheduled alarms, which already work.
WebSocket messages become events if the target's scenarios need them.

Gate: the target's object scenarios, on SQLite storage and including an
Agents SDK class, run with no `UNSUPPORTED` verdict.

### v0.13 — The system

The called Worker's real code runs in the same simulation as its caller:
its effects are recorded and interleaved with the caller's, and a fault
can land on either side, so a run follows a request across Workers end to
end. This is the hardest design, and it is written in `docs/design.md`
before any code; v0.10's scripted callees and v0.12's objects show what it
needs.

Gate: a scenario that drives one Worker, which calls another through a
service binding, runs both Workers' real code with no `UNSUPPORTED`
verdict, and catches a planted bug that crosses the two Workers, which
the same scenario with the callee scripted misses.

When a target needs them, outside these phases: an email binding with a
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
