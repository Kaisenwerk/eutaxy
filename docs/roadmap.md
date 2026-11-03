# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.12 — The agent loop (done)

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
first; a mirror or offline copy; the archives read with Node alone; its
gate, the `check` workflow installing both engines with the command and
the contract corpus passing on them) and v0.12 (`eutaxy mcp`, a stdio
server for the Model Context Protocol written with the standard library,
speaking both the stateless 2026-07-28 revision and the `initialize`
handshake before it, whose tools `check`, `report`, `goals`, `prove` and
`prover_status` return the JSON report; goal files, the Lean engine's open
goals written beside the spec file as a proof file with every proof open,
under the hashes of the module and the spec, so a proof file is stale once
either changed and nothing in it is `PROVEN`) are done; the design
describes what they built. The v0.12 gate: an end-to-end test over stdio
goes from a check to a violation with its regression test, and from the
open goals to a supplied proof to `PROVEN`, then stale once the module
changes, in both protocol eras.

`0.9.0` needs TypeScript 7.1 in the project (`typescript@7.1.0-beta`
until the release on 2026-11-24, then the release): the spec reader runs
the project's compiler. The reader follows the compiler's own releases
(the beta, the release candidate on 2026-11-10, the release) and is
pinned to each in turn. `readSpecs` takes the module's path
(`modulePath`, and `specPath`) in place of the import specifiers it used
to match by; the import is resolved by the compiler.

## Patch work alongside v0.14

Work toward v0.14 ships as `0.13.x`, and so does the following, each when
a target needs it:
- The remaining performance items: `report`'s module workers and the
  engines' modules run in parallel, toolchain lookups once per process,
  one Z3 prelude per module.
- The proof cache keyed by source, spec and engine version.
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

## v0.13 — Durable Objects on SQLite, and Agents (done)

Durable Object SQLite storage, the backend Cloudflare recommends for every
new namespace and the one the Agents SDK requires. The objects stay the
real ones workerd runs, with their gates and transactions; what changes
is what Eutaxy resets, seeds and snapshots. The `durableObject` setup
step takes tables beside its key-value rows: a reset clears SQL and
key-value data alike (as `deleteAll` does), the seed creates the
scenario's tables and inserts their rows through the Cloudflare Vitest
plugin's helpers as the key-value seed does, and the snapshot lists every
user table (from `sqlite_master`) with its rows beside the key-value
rows, so the state invariants read an object's SQL rows as they read D1
rows. `ctx.storage.sql.exec`, `transactionSync` and the synchronous
`ctx.storage.kv` need no new effect points: the input gate holds storage
calls, so they are not turns, as key-value calls are not; a `setAlarm`
inside `transactionSync` stays `UNSUPPORTED`, and so do the
point-in-time bookmarks. The differential corpus holds the model to
workerd, which implements SQLite-backed objects locally.

A class built on the Agents SDK (`Agent<Env, State>`) runs as written on
that storage: its state, one value in SQLite (`initialState`,
`this.state`, `setState`, `onStateChanged`), its `this.sql` tagged
template, and its schedules (`schedule`, `scheduleEvery`,
`listSchedules`, `cancelSchedule`), which the SDK keeps in SQLite and
runs over the object's one alarm, which Eutaxy already fires in virtual
time with several schedules over it. The Worker reaches the Agent as it
reaches any object, through `routeAgentRequest` or `getAgentByName` from
the HTTP drive. The target's Agents hold WebSocket connections, so these
are events too (`websocket` drive): a connection opened by the scenario
through the Worker's `fetch` and handed to an object (`onConnect`), and
each message it sends, delivered inside the object by its
`webSocketMessage` handler (`onMessage`) with the faults an alarm has; a
crash drops the instance and the runtime keeps the connection, as it does
across hibernation, so the next instance finds its server end again. What
the Agent sends back (`send`, `broadcast`, state sync) is recorded per
connection at the end of the run, in arrival order, and a close the
object makes is recorded; a client's close as a scenario event (`onClose`)
and the runtime's auto-response are not modelled, and a scenario that
needs them makes the run `UNSUPPORTED`.

Gate: object scenarios written the way the target writes them, on SQLite
storage and including an Agents SDK class with a schedule and WebSocket
connections (`corpus/gates/v0-13-agent-board`,
`corpus/gates/v0-13-websocket-connections`), run with no `UNSUPPORTED`
verdict, and a planted bug in an object's SQL rows is caught
(`corpus/planted-bugs/inventory-oversell-sqlite`). No differential entry:
the differential holds Eutaxy's binding proxies to the raw bindings, and
Durable Objects are the real objects workerd runs on both sides, so there
is no model of their storage to hold to workerd; what Eutaxy adds around
them (reset, seed, snapshot, the alarm takeover, connections) is what the
planted-bug and gate corpora exercise.

## v0.14 — The system (current)

The called Worker's real code runs in the same simulation as its caller:
its effects are recorded and interleaved with the caller's, and a fault
can land on either side, so a run follows a request across Workers end to
end. The scenario names the callee the way it names the caller (its
module and wrangler config), the service binding reaches that module's
`WorkerEntrypoint` or `fetch` instead of a scripted reply, and the
callee's effects run under an invocation of its own (the call's), on the
callee's bindings, which the scenario's setup seeds and snapshots as it
does the caller's; the trace names which Worker made each effect. v0.10's
scripted callees stay for the Workers a scenario does not run. This is
the hardest design, and its first step is the design itself, written in
`docs/design.md` before any code (one isolate or two, how the callee's
module is loaded under the Cloudflare Vitest plugin, what a crash on
either side means for the call in flight, how the two Workers' bindings
are told apart); v0.10's scripted callees and v0.13's objects show what
it needs.

Gate: a scenario that drives one Worker, which calls another through a
service binding, runs both Workers' real code with no `UNSUPPORTED`
verdict, and catches a planted bug that crosses the two Workers, which
the same scenario with the callee scripted misses.

## After v0.14

The phases after v0.14 are driven by the same target, and each one's text
is made exact, gate included, when it starts. When a target needs them, outside these phases: an email binding with a
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
