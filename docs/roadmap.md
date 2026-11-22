# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a set of tests run in CI on Workers written the way the phase's
target systems are; a phase is done when its gate passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## As of now

The phases through v0.18 are done; `docs/design.md` describes what they
built. A phase's gate is its go/no-go and passed in CI when the phase
closed; after the release what a gate's Workers hold is protection against
regressions, which belongs with the code it protects. So once a phase is
released its gate's tests move into the package that owns the feature
(`packages/<name>/workerd/<test>`, run inside workerd on every change), or,
for a system only the command can build (a Worker calling another by its
real name), into the command's own tests (`tests/systems/<test>`): the
replays as they are, and the exploration, where the gate ran a matrix of
cells, cut to one check per claim (exhaustive where the schedules are few,
a short seeded sample where not). Every gate through v0.17 has moved;
a new phase's gate is built where its tests will stay.
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
- **v0.16, work that goes on after the answer.** Two model features a
  real multi-Worker system reached first. An object that answers a call
  and goes on with work it did not await (`ctx.waitUntil`, a promise left
  running) runs that work as its own invocation,
  `DO:<binding>/<object>/after`, with its effects and faults, until it
  settles or a crash resets the object. A Workflow step's `timeout` is
  measured, a timeout at an attempt's start is a fault (`ambiguous` at
  `step`), and the timed-out attempt runs on as the late attempt, whose
  turns the run need not wait for: they land before, between or after the
  retry's or the recovery's. Under them, a virtual timer already due is a
  turn of the concurrent scheduler, and the Cloudflare delivery paths, the
  differential runner's raw side and the wrangler config reader are each
  one copy where they were several. Gate: an object's unawaited work and
  a timed-out step attempt each run as turns of their own, the object's
  timings around its answer (a timer awaited before it, an effect issued
  before it and not awaited, real work after it) each end in a verdict
  under every fault placement, a planted bug in each feature is caught (a
  lost update in work started after the answer, a late attempt running a
  turn abandoned meanwhile), the first has its differential entry (the
  local runtime models the Workflows engine rather than running it), and
  every example and the v0.14 gate stay green.
- **v0.17, inside the object.** A Durable Object is handed the Worker's
  real `env`, so what it called through its own bindings happened outside
  the simulation: not recorded, not faulted, and a service binding the
  scenario scripts was, inside the object, a placeholder nothing was
  meant to call. Now every binding on an object's `env` is what the
  Worker sees under that name. A call through a service binding is
  answered from the scenario's script or by the callee hosted inside it,
  a statement on D1, an operation on R2 and a call on a Workflow binding
  are recorded and faulted as the Worker's are, and a call on a binding
  the simulation does not model is refused. Each is an effect of the
  invocation the object's code runs as (the call it is serving, or
  `DO:<binding>/<object>/after` once it has answered), and leaves the
  object once its earlier writes are durable. A callee's object may call
  back into the caller's Worker. A constructor is inside the model from
  its first line, an object a crash reset and nothing entered since is
  woken inside the run before its storage is read, and a callback behind
  `blockConcurrencyWhile` that fails resets the object as the runtime
  does. Gate: an Agent whose work after its answer calls a scripted
  service and a callee, a callee's object that calls back into the
  caller's Worker and wakes its Workflow's wait, an object writing to a
  database and a bucket, and an object starting a Workflow instance,
  each ending in a verdict under every fault placement with no
  `UNSUPPORTED`; a planted bug caught for the service call, the callback
  and the stores (in each, a write outside the object that a fault
  separates from the object's own); a differential entry for the stores,
  the one case the local runtime under the test plugin runs by itself;
  and every example and earlier gate green.
- **v0.18, runs where they count.** An adopter's planted bug needed one
  Workflow step to time out on all three attempts and then one order of
  the late calls: three chosen fault points among some 180 a run, which
  sampling did not reach, so that test lived on `replay()` outside the
  command. A scenario's bounds now say where faults may go
  (`bounds.faultsAt`, `stepFaults`): a run spends its faults only at
  matching points, of the kinds listed, so the few placements left are
  explored with their orders. A scenario carries pinned schedules
  (`pinned`) that every check runs before it explores, each fault
  addressed by a site and the call's number in the run rather than by
  an invocation and a position, which shift with each fault placed
  before them; an `UNSUPPORTED` run that met something outside the model
  is handed back the same way (`replay`, `runPinned`) and the command
  writes a test that replays it. The check job gates what a run costs
  and the suite's time. A run of an object costs about nine runs of an
  ordinary scenario (`agent-poll` about 74 ms against `workflow-approval`'s
  8 on the CI runner): workerd's cheapest turn of its event loop is a
  zero timer of about 1.2 ms, and the scheduler takes one at each handoff
  into and out of an object's I/O context, where a move inside the object
  cannot wake it; one invocation at a time costs nearly as much, since
  the sequential path polls the same way. Three times was the aim before
  that measurement; the gate is the measured ratio, at most twelve, a
  guard against growth (`scripts/run-cost.ts`, after the suite), and a
  cheaper way across an object's I/O context waits among the candidates.
  The suite fails above 540 s on the CI runner, naming its slowest files
  (`tests/suite-ceiling.ts`); it took 272 s to 385 s over the phase's
  green runs on `main`, and the runner's load alone swings it: unchanged
  code took 333 s, 355 s and 359 s, then 453.6 s (`557091e` on `main`),
  then 384 s when run again, a swing of 36%. The slowest green run and
  that swing give 524 s, and the ceiling sits just above. The phase had
  set it at 420 s, which that 453.6 s run tripped, and so did a pull
  request's run a day later at 461.1 s, whose change added two seconds
  of tests and whose slowest files were ones it did not touch. A run
  that trips the ceiling with no growth in the files it names is the
  runner's load, and the ceiling is raised only with such runs recorded
  here. In the 453.6 s run a test that asserts every schedule was run, a
  second's work, spent its 30 s budget and failed. Such tests under
  `packages/cloudflare/workerd` and in the corpus now pass a clock that
  does not move, so the budget never ends their exploration early and a
  loaded runner slows them without failing them; the two that run the
  command (`tests/systems`) cannot, and give it 100 s. Gate: the planted
  bug of the adopter's shape (`workflow-fence-after-every-attempt`)
  `BOUNDED` under sampling with
  three faults a run, asserted, and `VIOLATED` by `eutaxy check` once the
  scenario says the step's attempts are where faults go; the same
  violation pinned by step name and attempt and replayed by the command;
  the fixed Worker holding under both; the per-run ratio and the suite's
  ceiling met in CI; and every example and earlier test green.

Notes on releases along the way:
- `0.18.0` closes v0.18; the patch work after it ships as `0.18.x`, and
  the next minor opens with v0.19. It also carries what was ready as
  `0.17.3` (fault sites, pinned schedules, the `UNSUPPORTED` replay),
  released with the phase rather than before it.
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

## Patch work

Work that changes no phase's gate ships as a patch release of the current
minor, each item when a target needs it (the performance items wait for
a measurement that asks for them):
- **Calls between Durable Objects and a scripted Durable Object**, the
  two things v0.17 first held, as `0.17.1`; both are in. One object
  calling another through its own `env` is an effect hosting the second
  object's code, with the faults a stub call has. A call nested in
  another call meets everything a call from the Worker does, so it was
  held until each timing was tested nested as it is tested from the
  Worker: the engine runs every timing directly and inside each nesting
  (an object, two objects, a called Worker, and their mixes) under every
  fault placement and compares the runs
  (`packages/engine/src/nested-calls*.test.ts`), and
  `packages/cloudflare/workerd/nested-object-timing` holds the v0.16
  timings nested against the real runtime, beside the calls' own workerd tests
  (`packages/cloudflare/workerd/object-calls-object`), the planted bug
  (`object-unit-twice-across-objects`) and the differential entry
  (`object-calls-object`). A scripted namespace (`scriptedObject()`)
  answers its objects' methods and `fetch()` from the scenario, as
  `service()` answers a Worker, each call an effect, from the Worker and
  from another object: for an object the isolate cannot run (one backed
  by a container) or one the scenario does not explore, which an
  adopter's second flow waited on. Its workerd test
  (`packages/cloudflare/workerd/scripted-object`) has an object calling
  scripted ones end in a verdict under every fault placement with nothing
  `UNSUPPORTED`, and
  the planted bug behind such a call
  (`object-machine-booted-off-record`) is caught.
- An `UNSUPPORTED` verdict carries the schedule of the run that reached
  it, as `0.17.1`; in. A reason says what a run met and not which run:
  without the schedule, seeing how a run got there meant opening the
  engine, which an adopter of the published package cannot do. The test
  the command writes to replay such a run is in v0.18, with pinned
  schedules.
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
- A setup step that gives a Worker or a callee a var or a secret by its
  (qualified) binding name: the command carries a callee's `vars` into
  the isolate but not its secrets, and a caller's come from the process
  environment, outside the scenario.
- A Worker's console output during a check, shown on request, to read
  why a callee refused a call without running the generated test by hand.
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
- Performance items no measurement asks for yet: the engines' modules in
  parallel and a proof cache keyed by source, spec and engine version
  (the report's time is the Lean prover's elaboration, run once per
  change in CI); one random stream per invocation, so a shrunk violation
  gets past the random ids an earlier event drew; dynamic partial-order
  reduction where the sleep-set reduction loses too often; and fresh
  module state per run, which would make the leak check fire less often
  at a cost in speed. Each is taken when a check or report time, or an
  adopter's run, shows it is the one that matters, which is the lesson of
  0.15.x: the performance items taken there on inspection showed no gain
  when measured.
- Left over from earlier phases: concurrent delivery on the AWS platform
  (it still delivers one event at a time); latency on scripted externals;
  Workflow rollback handlers.

## After v0.18

Each phase's text is made exact, gate included, when it starts. v0.19 is
the current phase; v0.20 needs the semantics the phases before it settled.

### Candidates: the larger gaps in the model

The `UNSUPPORTED` reasons that need model work of their own, most useful
first. Each waits until a target's code reaches it rather than being
built for coverage, and each becomes a phase, or joins one, with a gate
when it does:
- **A cheaper way across an object's I/O context.** A run with a Durable
  Object pays a real zero timer (about 1.2 ms in workerd) at each
  handoff into and out of the object, since a move inside the object
  cannot wake the scheduler without resuming it in the object's context
  (v0.18 measured about 3.6 such waits per effect point). A
  wake that crosses request contexts without a timer would bring an
  object's run near an ordinary one's; none is known yet.
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
often with fresh module state per run, at a cost in speed (among the
patch work's performance items, waiting for a measurement).

### v0.19 — Parallel calls, a steadier suite, one spine

Three pieces, in this order, then the release:
- **Calls in parallel inside one invocation are turns.** A handler that
  awaits two calls together (`Promise.all` over two object stubs) had its
  chains race in real time when one invocation ran at a time, and a check
  that saw two orders reported `module_state_leak`. It was the one
  candidate among the model's gaps that gave a wrong reason rather than
  none, so it goes ahead of the others: the first run that shows such
  calls makes the check start over with every asynchronous effect a turn
  (`docs/design.md`, "Calls in parallel inside one invocation").
- **A slow runner does not fail `main`.** One test's verdict rests on
  exhaustive exploration finishing within a budget of real time, and the
  suite's 420 s ceiling sits about 60 s above its usual time: a runner a
  third slower failed both on code that had passed three times.
- **One spine for the two prover engines**, which were written beside each
  other, so the model's translation has one place to live. The subset
  reader is already split along its seams, and no module imports in a
  circle.

Gate: a Worker awaiting calls into two objects together ends in a verdict
with every order run (`packages/cloudflare/workerd/parallel-object-calls`),
and both engines pass the prover contract corpus on the shared spine.

### v0.20 — The model proven

The first step of the long-term direction: the platform model of queues,
Durable Objects, D1 and alarms in Lean, validated against the executable
model as the engine's translation is validated today, so a scenario
invariant on the shell can be `PROVEN` against the model, not only
`BOUNDED` by exploration. It validates against the runs v0.18 measured
and gated, on the semantics v0.16 and v0.17 settled, and its translation
lives on the spine v0.19 gave the two engines.

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
