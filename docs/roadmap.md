# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.11 — Prover install (done)

v0.4 (the simulator), v0.5 (Durable Objects and specs), v0.6 (provers:
the `TESTED` rung, the first-party `prover-lean` engine with its contract
corpus and translation validation, the `Prover` interface, the `PROVEN`
rung and the aggregation across engines), v0.7 (specs in TypeScript, the
`prover-smt` engine over Z3 with doubles, code-unit strings and replayed
models, and nullable types and tagged unions in the subset reader), v0.8
(the self-check: `eutaxy report`, arrays and lists in the subset,
structural recursion in Lean, proofs supplied beside the spec file and
checked by the kernel, the invariant checkers held to naive references,
the enumeration model proven and the enumerator held to it), v0.9 (the
reader on the TypeScript compiler's API: binder types and the subset's
types are what the user's compiler resolves, so generic aliases
instantiated, inline object types, an alias declared later in the file,
a record literal told apart by its declared return type and types
imported from other files all read; narrowing by a union's tag) and
v0.10 (one Worker of a system of Workers checkable on its own, the
Workers it calls scripted: how a run chooses is one `Chooser` deciding
faults and turns alike, and each binding one record that the platform
and the differential runner both iterate; a drive that calls a
`WorkerEntrypoint` method over RPC, resends under the caller's declared
policy since Cloudflare does not retry a call; service bindings answered
from scripted replies with the fault meanings of a stub call, every
verdict stating that the callee was scripted; a drive for the
`scheduled` handler with its ticks from the cron expression and the
virtual clock; `step.waitForEvent` and `instance.sendEvent`, an instance
waiting in virtual time up to its timeout; its gate, a Worker driven over
RPC and by cron, calling another Worker through a service binding and
handing each order to a Workflow that waits for its event, runs with no
`UNSUPPORTED` verdict in `corpus/gates/`) and v0.11 (`eutaxy prover
install lean` and `… smt`: each engine's upstream release file per
platform, with its checksum, in a table beside the pin; downloaded only on
the command, checked before unpacking, into a cache the engines look in
first; a mirror or offline copy; the archives read with Node alone) are
done; the design describes what they built. The v0.11 gate: the `check`
workflow installs both engines with the command in place of its own
install steps and the contract corpus passes on them, a test shows a
checksum mismatch installs nothing, and a check whose engine is not
installed names the command.

`0.9.0` needs TypeScript 7.1 in the project (`typescript@7.1.0-beta`
until the release on 2026-11-24, then the release): the spec reader runs
the project's compiler. The reader follows the compiler's own releases
(the beta, the release candidate on 2026-11-10, the release) and is
pinned to each in turn. `readSpecs` takes the module's path
(`modulePath`, and `specPath`) in place of the import specifiers it used
to match by; the import is resolved by the compiler.

## Patch work alongside v0.12

Work toward v0.12 ships as `0.11.x`, and so does the following, each when
a target needs it:
- The remaining performance items: `report`'s module workers and the
  engines' modules run in parallel, toolchain lookups once per process,
  one Z3 prelude per module.
- A report path per run in `eutaxy check`, so two checks of one scenario
  running at once do not share Vitest's report file.
- The proof cache keyed by source, spec and engine version.
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

## v0.12 — The agent loop (current)

An MCP server and goal files for supplied proofs, so that a coding agent
runs the loop "check, read the report, fix or prove, check again" through
one tool, and Eutaxy itself never calls a model: verdicts depend only on
files in the repository.

`eutaxy mcp` is a local stdio server (one JSON-RPC message per line,
logs on stderr, exit when stdin closes) over the CLI and the JSON report,
written with the standard library alone, as the rest of the published
package is. It speaks both eras of the protocol: the `2026-07-28`
revision, stateless, every request carrying its version and client
capabilities in `_meta`, with `server/discover` answering the versions
supported; and the `2025-11-25` revision with its `initialize` handshake,
which the clients in use today still open with. Its tools are pure
functions of the repository's files and return the JSON report (schema 1)
as structured content beside a text form: `check` (a scenario, the
`check` options), `report` (a directory, the engines), `goals` (the open
proof goals), `prove` (a proof file against its goal) and `prover_status`
(the installed toolchains). A verdict is a result, whatever it says; only
a check that could not run is a tool error. Resources, prompts,
subscriptions and the HTTP transport are not in this phase.

Where the Lean engine's tactic script gives up on a property, the goal is
written to a file beside the spec file: the statement Eutaxy emitted, the
SHA-256 of the module source and of the spec file, the engine and its
version, and the `-- proof:` section left open, in the form of the proof
file the engine already accepts (`domain.props.lean`), so the goal file is
a template for it and nothing new is trusted. A supplied proof whose
statement or hashes no longer match its goal is stale: `UNKNOWN`
(`gave_up`, saying so), never `PROVEN`. It comes before the next Workers
because it makes checking them cheaper, and it is small.

Gate: an end-to-end test over stdio goes from a check to an open goal to a
supplied proof to `PROVEN`, in both protocol eras; a violation comes back
through the server as a replayable regression test; and a stale proof is
never `PROVEN`.

## After v0.12

The phases after v0.12, in order. Each is driven by the same target, and
each one's text is made exact, gate included, when it starts.

### v0.13 — Durable Objects on SQLite, and Agents

Durable Object SQLite storage (`ctx.storage.sql`): reset, seeded and
snapshotted table by table, its calls synchronous and held by the input
gate as storage calls are. A class built on the Agents SDK runs as
written, on that storage, with its scheduled alarms, which already work.
WebSocket messages become events if the target's scenarios need them.

Gate: the target's object scenarios, on SQLite storage and including an
Agents SDK class, run with no `UNSUPPORTED` verdict.

### v0.14 — The system

The called Worker's real code runs in the same simulation as its caller:
its effects are recorded and interleaved with the caller's, and a fault
can land on either side, so a run follows a request across Workers end to
end. This is the hardest design, and it is written in `docs/design.md`
before any code; v0.10's scripted callees and v0.13's objects show what it
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
