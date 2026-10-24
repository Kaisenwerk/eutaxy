# Eutaxy — Design

Status: design baseline. Package: `eutaxy`. The unscoped name matches the
`eutaxy` command, so `npx eutaxy check` needs nothing else; the npm
organisation `eutaxy` owns it and also holds the `@eutaxy` scope, which the
internal, unpublished packages use, so neither name depends on one owner.
This document is the current design and is rewritten in place as it changes;
the phase plan is in `docs/roadmap.md`. Rationale for a choice sits next to
the choice.

## Summary

Eutaxy ships first as a deterministic simulation checker for Cloudflare
Workers and grows into a tool that ties simulation to machine-checked proofs
of a Worker's pure core. It runs unmodified Worker code with its bindings
wrapped, injects faults at every effect boundary, explores runs from a seed,
and checks invariants over the effect log. A failure comes back as a shrunk,
replayable trace plus a Vitest regression test that runs in workerd.

Eutaxy answers three questions, each with its own verdict:
1. **Does the code survive crashes, retries and concurrency?** The simulator
   explores fault points and interleavings within stated bounds and reports
   `VIOLATED`, `BOUNDED` or `UNSUPPORTED`.
2. **Is the business logic right for every input?** Specs on pure core
   functions are checked on the inputs the simulator produced, then on
   generated inputs, then proved by an optional prover (`PROVEN`).
3. **Does the running code follow that logic?** The `refines` invariant
   checks that every effect the shell performs matches what the core decided,
   on the state that was current when the effect committed.

## Design principles

Eutaxy is built the way it asks users to build Workers: a pure core, a thin
effectful shell, and honest verdicts that say what they rest on.
- **Functional core, imperative shell.** Scheduling, invariant checking,
  shrinking and verdicts are pure functions over plain data. Effects
  (bindings, globals, workerd, child processes) live at the edges.
- **Own the interfaces, adapt what is young.** Eutaxy owns the spec IR, the
  verdict model, the report schema and its own proof engine. The spec
  _surface syntax_ is Lemma, a grammar with a neutral normative home and a
  conformance corpus; Eutaxy tracks it rather than forking it, because
  specs must translate one-to-one into whatever engine reads them and the
  corpus is free test material. Third-party provers and future platforms
  plug in through interfaces and can be swapped or dropped.
- **Zero dependencies in the core.** `spec` and `core` import nothing
  outside the repo, so they stay translatable by a prover and safe to
  self-verify. The published package has no runtime dependencies at all.
- **Plain data at every boundary.** The public API, the JSON report and
  anything crossing a process boundary are plain objects and discriminated
  unions, never library types.
- **Verdicts never overclaim.** `BOUNDED` is never called verified, `PROVEN`
  always names its engine and assumptions, and anything Eutaxy cannot
  control makes a run `UNSUPPORTED` instead of passing quietly.
- **False alarms are bugs.** Every reported violation is replayed before it
  is shown, and the platform model must never allow behaviour the real
  runtime cannot produce.
- **Schedule points are effect boundaries.** The scheduler controls exactly
  the points Eutaxy intercepts: proxied binding calls, patched timers and
  patched `fetch`. Every other `await` resolves in program order. This is
  what "exhaustive" and "bounded" range over. Instrumenting every `await`
  would need a code transform and change the code under test; races between
  two non-effect awaits are a documented limit, and `refines` catches their
  stale-read consequences when they reach an effect.
- **One install for users.** Users add `eutaxy` and nothing else;
  heavy toolchains are opt-in downloads.

## Verdict model

Two kinds of verdict, kept apart in every report: simulation verdicts about a
scenario, and spec verdicts about a pure function.

| Verdict       | Applies to | Means                                                                   | SZS mapping        |
| ------------- | ---------- | ----------------------------------------------------------------------- | ------------------ |
| `VIOLATED`    | scenario   | A replayed, shrunk trace breaks an invariant                            | CounterSatisfiable |
| `BOUNDED`     | scenario   | No violation in any explored run within the stated bounds               | Eutaxy extension   |
| `UNSUPPORTED` | scenario   | The run touched something Eutaxy cannot control, or did not replay      | Unknown            |
| `CHECKED`     | spec       | Held on every input the simulator actually passed to the function       | Eutaxy extension   |
| `TESTED`      | spec       | Held on generated inputs                                                | Eutaxy extension   |
| `PROVEN`      | spec       | Proved for all inputs by a named engine                                 | Theorem            |
| `REFUTED`     | spec       | A counterexample was found at any rung                                  | CounterSatisfiable |
| `UNKNOWN`     | spec       | No rung could decide; carries `gave_up`, `unsupported` or `unavailable` | Unknown            |
| `CONFLICT`    | spec       | Two engines disagree (one proves, one refutes)                          | Eutaxy extension   |

The spec ladder runs in order: `CHECKED`, then `TESTED`, then `PROVEN` when a
prover is installed and the function is in that prover's accepted subset. A
counterexample at any rung is always an error; a weak, missing or
inapplicable prover only lowers the verdict.

Every verdict carries provenance: seed, bounds reached and schedule-point
count for simulation; engine name, version and assumptions for proofs.
Assumptions include opaque callees, the platform model, declared externals,
and engine-level choices such as how `number` is modelled, reported as the
engine states them. `CONFLICT` is never resolved automatically.

## Architecture and module layout

One repository of small modules with one rule: dependencies point down into
a pure core, and provers plug in from the side.

Four layers, top to bottom: entry points (the published facade and the
CLI); shell and services (`cloudflare`, `report`, `prover`); the
platform-neutral `engine`; and the pure, dependency-free core (`spec`,
`core`), which is also the self-verification target. Each layer may use any
layer below it. Prover engines attach to `prover` from the side, loaded at
runtime over a process boundary.

| Module                                | Responsibility                                                                                                                                                                        | May import       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `spec`                                | `SpecIR`, Lemma annotation parser and printer                                                                                                                                         | nothing          |
| `core`                                | Effect log, fault model, seeded PRNG, `Platform` interface, schedulers (seeded; exhaustive and partial-order reduction from v0.5), invariants including `refines`, shrinker, verdicts | `spec`           |
| `engine`                              | Run loop, virtual clock, globals patching, per-run state reset, replay                                                                                                                | `core`           |
| `cloudflare`                          | Binding proxies, platform model, allowlist, Vitest integration                                                                                                                        | `engine`, `core` |
| `aws`                                 | AWS SDK `send` proxy, SQS-to-Lambda delivery model, DynamoDB reset and snapshots; runs in Node                                                                                        | `engine`, `core` |
| `prover`                              | `Prover` interface, spec ladder, aggregation                                                                                                                                          | `core`, `spec`   |
| `prover-lean`                         | First-party engine: pure-TypeScript subset to Lean 4, tactic stack, translation validation                                                                                            | `prover`, `spec` |
| `prover-thales`, `prover-lemmascript` | Optional process-boundary adapters for third-party engines                                                                                                                            | `prover`         |
| `report`                              | Text, versioned JSON, Vitest regression emitter                                                                                                                                       | `core`           |
| `cli`                                 | Commands, config, adapter discovery                                                                                                                                                   | all of the above |
| `eutaxy` (facade)                     | Public API at `eutaxy`, `eutaxy/cloudflare` and `eutaxy/aws`                                                                                                                          | all of the above |

Outside `packages/`, the repository holds `corpus/` (planted bugs,
differential scenarios, prover contracts; never published), `examples/` and
`docs/`.
- Boundaries are enforced by the package manager: each package declares
  exactly its allowed imports, and pnpm's isolated workspace links only
  declared dependencies, so a forbidden import does not resolve. TypeScript
  project references mirror the declarations for build order; a test keeps
  declarations, references and this table in sync. (Project references alone
  do not enforce this: imports by package name resolve through
  `node_modules` and are exempt from the composite file-list check.)
- Only `cloudflare` knows about Cloudflare and only `aws` knows about AWS;
  each is a sibling package implementing `Platform`, and the engine, the
  invariants, the shrinker, the report and the CLI are shared.
- Only `engine` patches globals (`Date`, `Math.random`,
  `crypto.randomUUID`, `crypto.getRandomValues`, `performance.now`, timers,
  and later `fetch`); schedulers draw randomness from `core`'s PRNG and
  nothing else.
- `core` and `engine` never import provers; the CLI loads engines from
  config.

## Spec language, invariants and refines

Users write one spec per pure function and one spec file per scenario;
Eutaxy derives every check from those two sources.

**Function specs** live in JSDoc on pure core functions in the Lemma dialect:
`@requires`, `@ensures`, `@total`, `forall` binders and `==>`, with opaque
TypeScript expressions at the leaves. Eutaxy parses them into its own
`SpecIR`, which can also carry loop invariants for engines that need them.

```ts
/** @total
 *  @ensures result.kind === "reject" || result.newBalance === w.balance - amount */
export function decideWithdraw(w: Wallet, amount: Natural): Decision { ... }
```

**Scenario specs** (`*.sim.ts`) are TypeScript files whose default export is
a `ScenarioSpec`: plain data naming the Worker (entry and wrangler config),
how to drive it, the state to set up before each run, the declared
externals, the invariants and the bounds. The platform-neutral shape lives in
`core`; the parts only a platform understands (`drive`, `setup`) travel as
`PlatformData`, JSON tagged with a `kind`, built by typed helpers in the
platform package. For Cloudflare:

```ts
import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  queue,
} from "eutaxy/cloudflare";

const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "queue-duplicate-write",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
```

A scenario has one drive. `queue(name, messages)` drives the `queue()`
handler. `http(requests, { retries, retryOn })` drives the `fetch()` handler:
each request (method, path, headers, JSON or text body) is an event like a
message, delivered under the same faults; the response the handler returns
is recorded as an effect (`Http:<path>`, op `response`) whose one admitted
fault, a crash before it, is the response the caller never received. The
caller's retry policy, not Cloudflare's, decides redelivery: a webhook
provider resends until it gets a 2xx (`retryOn: "non-2xx"`, the default)
or only on failures and 5xx (`"5xx"`), up to `retries` times; a browser-like
caller has `retries: 0`. An uncaught exception is a 500 response.
`httpResponse(path, { ok })` selects responses for invariants such as "one
2xx per request", and `atLeastOncePerMessage` accepts either drive.

Invariants are plain data over the effect log, checked by pure functions.
An _effect selector_ picks records by target, op, kind and payload fields;
a _key_ is a dot path into the payload. The library starts with
`atMostOncePerKey` (no two selected effects share a key) and `atLeastOnce`
(every expected key appears), which the first planted bug needs, and two
_state_ invariants over a snapshot of D1 taken after the last event and
recorded into the log: `everyRow` (every row a state query selects satisfies
a list of column conditions) and `implies` (every selected effect, keyed by
a path into its payload, has a row whose column equals that key). A missing
snapshot is a violation, never a silent pass. Effect payload conventions per
binding are documented in the `cloudflare` package README.

**`refines(core, { state })`** is the bridge between the two. It checks that
each effect the shell performs matches a decision the core returned, and that
the decision was made on the state that was current when the effect
committed, which catches stale reads. It does not replace system invariants:
a shell can follow the core faithfully and still break a system property, so
both are always checked.

**Externals declare their guarantees and script their replies.** Outbound
`fetch` never reaches the network. A scenario declares each external the
Worker talks to with its host (exact or a `*.suffix` pattern), optional
scripted responses matched by method and path (every request gets 200 and
an empty body when none are scripted), and what it guarantees under
retries, for example `dedupeBy: "Idempotency-Key"`: a request repeating an
earlier one's key gets the earlier reply and is recorded as not effective,
so invariants over `Fetch:<external>` count only effective requests. Each
request is an effect point with every fault available, including the
ambiguous outcome where the request committed but the caller saw an
error. A request to an undeclared host, or one no scripted reply answers,
makes the run `UNSUPPORTED`. A verdict is only as good as these
declarations, so they are listed among its assumptions.

## Fault model and platform model

The fault model is platform-neutral and lives in `core`; what Cloudflare
promises lives in one reviewable module, `cloudflare/model`, separate from
the binding proxies.

Faults injected at every effect boundary:

| Fault               | What happens                                                                                                                                                     | Why it matters                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Crash before effect | The effect never happens; the invocation dies                                                                                                                    | Lost work, missing writes      |
| Crash after effect  | The effect happened; the invocation dies before continuing                                                                                                       | Duplicate effects on retry     |
| Ambiguous outcome   | The effect committed but the caller sees a timeout or error                                                                                                      | Breaks most retry logic        |
| Error               | The effect fails cleanly with an error                                                                                                                           | Error-handling paths           |
| Redelivery          | A queue message or alarm is delivered again; an inbound request is resent by its caller                                                                          | At-least-once semantics        |
| Cut-off             | The acknowledgement or response was sent; work scheduled with `waitUntil` that has not started is lost, and an effect in flight commits without its continuation | Background work that never ran |

**Platform semantics to encode, with a documentation source for each:**
- D1: `batch()` is all-or-nothing; separate `run()`/`first()`/`all()` calls
  are each one effect and can be cut between statements; prepared statements
  are not effects until executed.
- Queues: at-least-once delivery; per-message `ack()`/`retry()`, batch
  `ackAll()`/`retryAll()`; a crash mid-batch redelivers every unacked
  message; `max_retries` and dead-letter queues.
- Inbound requests: one invocation per attempt; an uncaught exception in
  `fetch()` is answered with a 500 (Workers runtime); resends follow the
  drive's declared caller policy, since Cloudflare itself never retries an
  inbound request. The policy has a count (`retries`), what counts as
  failed (`retryOn`), the virtual delay before each resend (`delaysMs`) and
  how long the caller waits for an answer (`deadlineMs`). The caller
  decides at the response point, or at its deadline (a virtual timer set
  when the request is sent) if the handler has not answered by then, never
  when the handler's background work ends: the resend is queued at that
  moment (`RunHooks.enqueue`, with the virtual time it is due), so with
  concurrent invocations it can start while the first attempt still runs.
  The differential runner rejects drives with caller timing until it
  models it on both sides. Because the handler's own time is virtual, a
  late answer is either an answer later than `deadlineMs` in virtual time
  or the `ambiguous` fault at the response point, offered only when the
  drive declares a deadline: sent, counted as failed by the caller, and
  the handler carries on. A delayed event waits until the virtual clock
  reaches it; the engine moves the clock there once nothing else can move,
  firing timers due before it first.
- Durable Objects (v0.5): input gates block new events during storage
  operations but not during outbound `fetch`; output gates hold responses
  _and outgoing requests_ until pending writes are confirmed; consecutive
  synchronous writes with no intervening `await` coalesce into one atomic
  transaction; `blockConcurrencyWhile` is honoured; the SQLite storage API
  is synchronous; an alarm whose handler throws is re-run from the start.
  Eutaxy does not re-implement any of this. The objects are the real ones
  workerd runs, as D1 is Miniflare's real SQLite, so storage, transactions
  and gates are the runtime's own; workerd also refuses to construct a
  `DurableObject` subclass outside the runtime, which rules out running
  the class against a model. Eutaxy proxies the boundary a Worker crosses:
  each stub call is one effect, where `crash_before` and `error` mean the
  call never reached the object, `ambiguous` that the object committed and
  the answer was lost, and `crash_after` that the caller died after the
  call. Through the Cloudflare Vitest plugin's test helpers each object is
  cleared, seeded from the scenario's `durableObject` setup and evicted
  before a run, so it starts from storage alone, and its storage is
  snapshotted after it (rows `{ key, value }` per object name). Alarms are
  taken over on each object's storage, inside transactions too, so none is
  scheduled on the real clock, whose time is far ahead of the virtual one,
  and they fire in virtual time: Eutaxy keeps one alarm per object (a later
  `setAlarm` replaces it, a transaction's applies on commit of the attempt
  that commits, an alarm set in the constructor is moved over unless one
  is still pending, which makes the run `UNSUPPORTED` because natively the
  constructor would have seen it, as does a rebuilt constructor that reads
  the alarm while one is pending (reads before the takeover are recorded
  on the storage prototype); each change starts a new generation, so
  an alarm or retry it supersedes is dropped before any fault applies),
  it survives eviction, and when the
  run reaches its time the object's `alarm()` runs as one effect. Alarms
  run at least once (Cloudflare, Durable Object Base API): `crash_before`
  means it never ran, `crash_after` that it ran and committed but counts
  as failed (either crash also drops the instance, so in-memory state is
  lost as in a real crash), `error` that it threw, and a failed alarm is
  retried after
  2 s, 4 s, 8 s, up to six retries and `maxRedeliveries`, with
  `retryCount` and `isRetry`. Several schedules over one alarm (the
  pattern the Agents SDK uses) work as written. An object that keeps
  re-arming fires at most `alarmsPerObject` times per run (default 3). A
  `setAlarm` inside `transactionSync()` makes the run `UNSUPPORTED`. A
  crash injected inside an object's own work resets the object with
  `ctx.abort()`, as a crash does, called where the crash happens because
  abort() works only from inside the object. Current limits: calls run one at a time, so races between
  an object's own outbound I/O and another call into it are not explored;
  the object's own binding calls are not recorded, and an object reached
  only through another object's binding makes the run `UNSUPPORTED`, as do
  `newUniqueId` (random), `jurisdiction()` namespaces and a namespace the
  scenario does not reset (no `durableObject` setup). An object no call
  reached is snapshotted from its seed without being constructed. Reset
  constructs each object outside the simulation, with the network blocked:
  a constructor that makes a request fails the reset. A stub property can
  be called (a method) or awaited (an RPC getter); either is one effect.
  A result that is not plain data (an RPC capability) makes the run
  `UNSUPPORTED`, since calls on it would bypass the proxy; an effect the
  object makes during a call (its own `fetch`) runs within that call's
  turn in a concurrent run.

**Fidelity rules:**
- Proxies intercept calls but execute them against the real local
  implementation (Miniflare's D1 and storage), so SQL and storage semantics
  come for free.
- An allowlist of proxied bindings; anything else (Cache API, service
  bindings, AI, Hyperdrive, raw sockets) makes the run `UNSUPPORTED`.
- Determinism-breaking APIs that are not virtualised (`WeakRef`,
  `FinalizationRegistry`) also make the run `UNSUPPORTED`; `performance.now`
  is virtualised along with the clock.
- Production-only behaviour the simulator cannot see (D1 read replication,
  real queue batching, real latency) is documented as out of scope.

## Running inside workerd

Eutaxy runs through the user's own Vitest setup with the Cloudflare Vitest
plugin, so the TypeScript loader, workerd and bindings all come from the
user's existing configuration. The engine relies on three documented
properties of that integration and names them as assumptions in every
verdict:
1. The main Worker runs in the same isolate as the test, so the engine's
   global patches apply to it.
2. Storage isolation is per test file. Exploration runs many schedules
   inside one test, so the engine resets bindings and Durable Object memory
   between runs itself, using the integration's reset helpers.
3. Module caches are reused and no fresh-module-per-run API exists, so
   module-level state cannot be reset. Before reporting `BOUNDED` the
   engine replays the first exploration runs in reverse order and compares
   their logs with the originals; any difference downgrades the verdict to
   `UNSUPPORTED` with cause `module_state_leak`. The pass costs two extra
   runs by default and can be sized or disabled per check.

A run's _schedule_ is the list of injected faults, each keyed by invocation
and by the effect's ordinal within that invocation (not by a global index),
so a schedule stays valid when other invocations are removed. Replay follows
a schedule exactly; exploration records one.

**Concurrent invocations.** With `maxConcurrentInvocations` above 1, up to
that many invocations are in flight, as concurrent requests are in one
isolate ("other requests may (or may not) be processed during awaiting any
`async` tasks", Cloudflare, How Workers works) and concurrent queue
consumers are up to `max_concurrency` (Cloudflare, Consumer concurrency).
Each
asynchronous effect is a turn: the invocation parks there, and once every
invocation in flight has parked, finished or gone idle, the engine lets
one parked invocation perform its effect and run to its next one, or,
while a slot is free, starts the next event; timers fire only when nothing
else can move; an invocation that waits
on nothing Eutaxy can see makes the run `UNSUPPORTED`. The pick among
parked invocations comes from a stream seeded by the run's seed, separate
from fault decisions, so replay makes the same picks and the schedule
needs no record of them. Synchronous effects (an ack, the response point)
are not turns. Each delivery runs in its own async context
(AsyncLocalStorage), so `RunHooks.running` names the invocation whose code
is executing even when a promise shared between invocations resumes one
during another's turn; a host without it gets `UNSUPPORTED`. A platform
declares `concurrent` once nothing it shares between deliveries depends
on which invocation is running; the Cloudflare
platform does, the AWS platform does not yet. A shrunk schedule keeps the
seed, so removing a fault can change later picks; the shrinker keeps a
candidate only when replay still violates, as for any other change.

The _shrinker_ takes a replayed violation and tries, smallest change first,
removing one fault and then removing one input event, keeping a candidate
only when replay still violates the same invariant for the same keys.
Invariants whose expectations were derived from the input (per-message
`atLeastOnce`) are re-derived for the remaining events, so a shrunk scenario
cannot "violate" merely because its expectations went stale. The verdict
reports the kept events, the shrunk schedule and the replayed shrunk trace.

**Virtual clock and globals.** For the duration of a run the engine
replaces `Date`, `Math.random`, `crypto.randomUUID`,
`crypto.getRandomValues`, `performance.now` and the timer functions with
deterministic versions derived from the run's seed. Time starts at
2026-01-01T00:00:00Z and advances one millisecond per completed effect and
to each timer's due time when it fires. Timers fire only while the
invocation is idle, meaning no effect is in flight, in due order, so they
never race real I/O. Platforms wait for handler and background promises
through the engine's `settle`, which lets real I/O complete, fires due
timers, abandons a crashed invocation, and marks the run `UNSUPPORTED` when
user code waits on something Eutaxy cannot see. Web Crypto calls
(`crypto.subtle`) are real work the handler waits on but not effects: the
engine waits for them like an effect's I/O, unrecorded and never faulted,
so timers and turns are never decided while one is running; that matters
for webhook handlers that verify a signature. An effect whose real I/O
outlasts the scenario's `budgetMs` is treated as hung and the run is
`UNSUPPORTED`, naming the effect, instead of waiting forever. The globals
are restored after every run, including on failure. Code that captured `Date.now` or
`Math.random` at module load escapes the patch; that is a documented limit.

Each run resets D1 by dropping every user table and re-applying the
scenario's schema through the real binding, outside the effect log. Queue
messages are delivered one at a time; an unacknowledged message is
redelivered up to `max_retries` (default 3) and within the scenario's
`maxRedeliveries`, then dead-lettered, which the log records.

The CLI's `check` command generates a test file and invokes the user's
Vitest, rather than hosting workerd itself. That keeps the CLI free of
runtime dependencies. Concretely, `eutaxy check <scenario.sim.ts>` writes a
`.eutaxy/` directory beside the scenario holding a test that performs the
check inside workerd and a Vitest config with the Cloudflare plugin pointed
at the wrangler config found beside the scenario (or given with
`--wrangler`). The test resolves the Worker and schema files with Vite globs
from the scenario's own `worker.entry` and `setup`, stores the verdict in
its Vitest task meta, and the CLI reads it back through Vitest's JSON
reporter: nothing depends on console output. The CLI then prints the text
report or the JSON report, writes `<name>.regression.test.ts` on a
violation, removes `.eutaxy/`, and exits 0, 1 or 2 for `BOUNDED`,
`VIOLATED` or `UNSUPPORTED`. In development the CLI runs its TypeScript
sources directly on Node 24, which is why relative imports name `.ts` files.

## The AWS platform

The second platform is AWS Lambda consuming SQS with DynamoDB, in
`packages/aws`. It shares everything above the `Platform` interface and
differs from Cloudflare in three ways.
- **Runtime.** Lambda handlers run in plain Node, so the platform needs no
  runtime emulator: the engine, the handler and the local services share
  one process. The handler receives an SQS event with one record and a
  Lambda context whose request id and clock are virtual.
- **Effect boundary.** Every AWS SDK v3 client extends one Smithy `Client`
  whose `send` is the single point every call passes through. For the
  duration of a run it is replaced: the call becomes an effect point
  (`DynamoDB:<table>` with the low-level command name as op, DocumentClient
  commands normalised to it, a batch or transaction naming every table it
  touches joined with `+`; all faults available for
  writes), and the real work is sent through a local client the platform
  was given, matched by the calling client's class name. The handler's own
  clients, built at module scope the way Lambda code does, never reach the
  network. A client class without a local counterpart makes the run
  `UNSUPPORTED`. DynamoDB semantics, including conditional writes, come from
  the local DynamoDB the user runs (DynamoDB Local, LocalStack, or dynalite
  in this repository's tests).
- **Delivery model**, as documented by AWS for SQS event sources: a
  successful return deletes the message (recorded as an implicit `delete`
  effect, the point where crash faults land between "handled" and
  "deleted"), a thrown error or a reported batch item failure leaves it to
  be redelivered, and after the queue's `maxReceiveCount` deliveries it is
  dead-lettered.

Two consequences of sharing a process with the local service are built in.
Reset and the end-of-run snapshot run with the real globals installed, so
an in-process DynamoDB keeps its own timers; and while any effect performs
its real I/O, timers the SDK schedules inside that I/O are real, because
SDKs back off and time out with them, while timers the handler schedules
meanwhile stay virtual. The engine tells the two apart with Node's
`AsyncLocalStorage`, which follows the SDK's promise chains and I/O
callbacks but not the handler's own continuations; where it is unavailable
(workerd without Node compatibility) every timer stays virtual, which the
Cloudflare bindings do not need. The clock, `Date` and randomness stay
virtual throughout.

## Provers

Proving is optional. `CHECKED` and `TESTED` need no engine, and a listed
engine that is not installed only lowers a verdict to `UNKNOWN`. Every
engine, first-party or not, sits behind one interface Eutaxy owns and runs
over a process boundary.

**First-party engine (`prover-lean`).** Eutaxy's own TypeScript-to-Lean 4
engine, so that the strongest verdict never depends on an external
project's roadmap. It accepts a defined pure subset of TypeScript
(immutable data, algebraic types, structural recursion, bounded integers,
quantifier-free arithmetic first), emits Lean 4 with the `SpecIR`
obligations, discharges them with a curated tactic stack, and maps results
back to source locations. The subset is specified operationally by a
contract corpus and widens one characterised class at a time. Translation
validation, where the emitted Lean must reproduce the program's behaviour on
the corpus, is part of the engine's own tests. The Lean toolchain is an
opt-in download; the Lean kernel, not Eutaxy, checks the proof.

**Third-party adapters** (Thales, LemmaScript) are optional, and exist for
cross-checking and for code outside the first-party subset.

```ts
export interface Prover {
  readonly name: string;
  readonly capabilities: { preconditions: boolean; loops: boolean; quantifiers: boolean };
  available(): Promise<boolean>;
  prove(spec: SpecIR): Promise<ProofVerdict>;
}
```

Adapter rules:
- Talk to engines over a process boundary (spawn, files, parsed output),
  never a library import, so Lean and Dafny stay out of Eutaxy's install.
- Users write specs once; each adapter generates its engine's annotation
  syntax into a temporary copy and maps results back to source locations.
- Record engine name and version with every `PROVEN`, and cache results
  keyed by source hash, spec hash and engine version so CI does not
  flip-flop.
- Treat timeouts as `UNKNOWN`, never as failures; prefer Lean backends where
  determinism matters.
- Each adapter has a contract corpus of functions with known verdicts
  (provable, refutable, out of scope), including spec-translation cases, run
  in CI against the pinned engine version.
- Aggregation across engines: one proves and another gives up gives `PROVEN`
  with the proving engine named; one proves and another refutes gives
  `CONFLICT`.

| Engine                      | Best for                                                      | Backend         | Main caveat                                               |
| --------------------------- | ------------------------------------------------------------- | --------------- | --------------------------------------------------------- |
| `prover-lean` (first-party) | Push-button proofs of the pure core, on Eutaxy's own schedule | Lean 4          | Subset starts narrow and widens deliberately              |
| Thales (optional)           | Cross-check; pure functional TypeScript                       | Lean 4          | Strict subset (no mutation, no classes); separate project |
| LemmaScript (optional)      | Imperative code with loop invariants                          | Lean 4 or Dafny | Tech preview; Dafny's SMT results can vary with timeouts  |

## Packaging, distribution and developer experience

- One published package, `eutaxy`, with subpath exports `.` and
  `./cloudflare` and a `bin` for the CLI. Internal packages are bundled into
  it at build time (`pnpm build`, tsdown from the repository root, ESM with
  bundled declarations); they are declared as its dev dependencies, so the
  published manifest has no runtime dependencies. `publishConfig` swaps the
  workspace entry points (TypeScript sources) for `dist/` on publish, and a
  test packs the tarball and checks it is self-contained. Releases are
  published by a GitHub Actions workflow on a version tag through npm
  trusted publishing (OIDC) with provenance: the workflow packs with pnpm,
  so `publishConfig` applies, and publishes the tarball with npm.
- Peer dependencies only for what users already have: Vitest and the
  Cloudflare Vitest plugin, pinned to tested major versions because that
  integration's API has moved more than once.
- Provers opt-in: `eutaxy prover install thales` fetches a pinned,
  checksum-verified toolchain bundle. Projects list engines in
  `eutaxy.config.ts`; a listed engine that is not installed yields
  `UNKNOWN`. Never `optionalDependencies`, never a silent download during a
  check.
- Split into separate packages later only for a reason, most likely the
  prover adapters. Released in lockstep with exact version pins.

| Command                        | Does                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `eutaxy check <spec>`          | Run a scenario; print the verdict and the shrunk trace, write a regression test |
| `eutaxy prove <file>`          | Run the spec ladder on pure functions                                           |
| `eutaxy report`                | Combined view: spec verdicts per function, simulation verdicts per handler      |
| `eutaxy prover install <name>` | Download a pinned prover toolchain                                              |

Every command takes `--json`, printing one object in a versioned schema
(`schemaVersion` 1, canonical JSON) for CI and coding agents. A failing check
writes a Vitest file that replays the shrunk schedule on the restricted
scenario inside workerd and expects the invariants to hold, so it fails
while the bug exists and passes once fixed; `expectHolds` and `check` from
`eutaxy/cloudflare` run the same check from a user's test suite.
The emitter in `report` knows no platform: the Cloudflare entry point
supplies the imports and the platform expression.

Default exploration budget is time-based (a few seconds) with the bounds
actually reached reported in the verdict, rather than a fixed count.

## Trust anchors and self-verification

Eutaxy checks as much of itself as it can with its own tools, but its final
word comes from anchors it does not control.
- **Planted-bug corpus** (`corpus/planted-bugs`): Workers with known bugs,
  each with the verdict Eutaxy must reach. CI fails if any is missed. This
  guards against the checker that cannot fail.
- **Differential corpus** (`corpus/differential`): fault-free scenarios run
  twice inside workerd, once through Eutaxy's proxies and once with the
  handler called directly on the raw bindings; the per-attempt decisions
  and the final D1 tables must agree. Any divergence is a bug in Eutaxy's
  proxies or platform model. The raw side shares Eutaxy's reading of the
  queue semantics but none of the proxy code.
- **Lean kernel**: proofs that pass through a prover adapter are checked by
  Lean, not by Eutaxy, so they are independent of Eutaxy's own code.

Self-verification targets, by cost of a bug:

| Component             | Spec                                                                                                            | Cost of a bug                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Exhaustive enumerator | Every schedule within bounds appears exactly once; count equals a closed-form formula; same seed, same schedule | False `BOUNDED` on every check     |
| Invariant checkers    | Match a naive reference implementation on the same effect log                                                   | False `BOUNDED` for that invariant |
| Verdict logic         | `VIOLATED` only after a successful replay                                                                       | False alarms                       |
| Shrinker              | Output still violates and is no longer than input                                                               | Unhelpful traces only              |

Not self-verifiable: binding proxies, globals patching and the workerd/Vitest
glue (covered by differential testing), and the spec parser (a common-mode
failure, covered by the Lemma conformance corpus, parse-print-parse round
trips and fuzzing).

## Risks

| Risk                                                                            | Mitigation                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Platform model is wrong or goes stale (Cloudflare documents semantics in prose) | Differential corpus against workerd; assumptions listed in every verdict                  |
| False `BOUNDED` from module-level state leaking between runs                    | Two-order detection, downgrade on mismatch                                                |
| State explosion once Durable Objects and multiple messages arrive               | Partial-order reduction (independent keys commute); explicit bounds in every verdict      |
| False alarms from impossible Durable Object interleavings                       | Real objects, so the runtime's own gates apply; every violation replayed before reporting |
| Prover engines are young and churn                                              | Optional adapters, pinned versions, contract corpus, graceful `UNKNOWN`                   |
| Numeric semantics differ between engines and JavaScript                         | Engine-level number model recorded as an assumption; `CONFLICT` when engines disagree     |
| Cloudflare Vitest integration changes its API again                             | Peer-dep pinned to a tested major; the three assumptions above are tested in CI           |

## Open questions

- Durable Objects beyond the stub boundary, in order: interleaving at an
  object's own outbound I/O (and alarms concurrent with calls, which
  Cloudflare allows), then recording the object's own binding calls.
- Whether the Lemma conformance corpus is enough to pin the spec parser, or
  Eutaxy needs its own extension fixtures for loop invariants.
