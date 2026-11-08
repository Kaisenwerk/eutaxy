---
description: How Eutaxy simulates Cloudflare Workers - D1, Queues, inbound HTTP and RPC, Cron Triggers, outbound fetch, Durable Objects with alarms, R2 and Workflows, the documented semantics each follows, the effects each records, and what makes a run UNSUPPORTED.
---

# Cloudflare Workers

Eutaxy runs your Worker inside workerd, through your own Vitest and the
Cloudflare Vitest plugin. Bindings are the real local implementations
(Miniflare's D1 and R2, the Durable Objects workerd runs); Eutaxy wraps the
boundary your Worker crosses, records each call as an effect, and decides
the faults. Each binding's model follows Cloudflare's documentation, which
the verdict's assumptions cite.

## Bindings

| Binding           | Setup             | Each effect                                   | Model                                                                                                            |
| ----------------- | ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| D1                | `d1Schema`        | `run`, `first`, `all`, `raw`, `batch`, `exec` | Miniflare's SQLite. `batch()` is all-or-nothing; separate statements can be cut between                          |
| Queues (consumer) | the `queue` drive | `ack`, `retry`, background work               | At-least-once delivery; first ack or retry per message wins; redelivered up to `max_retries`, then dead-lettered |
| Inbound HTTP      | the `http` drive  | the response                                  | One invocation per attempt; an uncaught exception, or a result that is not a `Response`, is a 500; the declared caller decides resends                  |
| Inbound RPC       | the `rpc` drive   | the response                                  | One invocation per call attempt, the entrypoint constructed per call; an exception is the error the caller sees  |
| Cron Triggers     | the `cron` drive  | `no_retry`, background work                   | One invocation per tick attempt at the tick's virtual time; the declared re-runs of a failed tick, none after `noRetry()` |
| Outbound `fetch`  | `external`        | each request                                  | Answered from the declared externals; never reaches the network                                                  |
| Durable Objects   | `durableObject`   | each stub call, each alarm                    | The real objects: storage, transactions, input and output gates are the runtime's own                            |
| R2                | `r2Bucket`        | `put`, `delete`, `get`, `head`, `list`        | Miniflare's buckets; strongly consistent, last writer wins, conditional operations as documented                 |
| Workflows         | `workflow`        | `create`; two points per `step.do` attempt    | A model of the engine: step retries with backoff, restarts that re-run `run()` with persisted step results       |
| Service bindings  | `service`         | each RPC call, each `fetch()`                 | The callee scripted: replies from the setup; faults as a Durable Object stub call; never retried by Cloudflare   |

### D1

Each `run()`, `first()`, `all()`, `raw()`, `batch()` and `exec()` is one
effect. A `batch()` commits all or nothing; separate statements can be cut
between. Prepared statements are not effects until executed. Each run
resets the database by dropping every user table and re-applying the
schema.

### Queues

Messages are delivered one at a time, one invocation per delivery attempt.
Per-message `ack()` and `retry()` and batch `ackAll()` and `retryAll()`
are effects; the first decision per message wins. A crash mid-batch
redelivers every unacknowledged message, up to the consumer's `max_retries`
(default 3) and the scenario's `maxRedeliveries`, then dead-letters it.
`message.timestamp` is the virtual time at delivery.

### Inbound requests

The `http` drive calls `fetch()` once per attempt. The response is an effect
whose one fault, a crash before it, is the response the caller never
received. Cloudflare never retries an inbound request, so the caller policy
you declare (`retries`, `retryOn`, `delaysMs`, `deadlineMs`) decides
resends.

### Inbound RPC

The `rpc` drive constructs the `WorkerEntrypoint` once per call, as the
runtime does, and calls the method. The return value is the response effect
(`Rpc:<method>`, `{ ok: true, value }`); an exception reaches the caller as
a new error with its name and message (`{ ok: false, error }`). Cloudflare
never retries an RPC call, so the caller policy you declare (`retries`,
`delaysMs`, `deadlineMs`) decides resends. A result that is not plain data
(a stub, a function, a stream) makes the run `UNSUPPORTED`; an entrypoint's
own `fetch()` method is not driven by `http()` yet.

### Cron Triggers

The `cron` drive fires the expression's ticks from the virtual epoch on,
each at its virtual time, so `scheduledTime` and the clock agree. Cloudflare
documents `noRetry()` but not how a failed invocation is retried, so the
drive declares the re-runs; `noRetry()` is recorded as a decision and ends
them. `L`, `W` and `#` in an expression are not modelled.

### Service bindings

The Worker behind a service binding is scripted, never called: the
`service` setup names each method's reply (a value, or an error thrown to
the caller with its name and message, as RPC propagates it) and the replies
to `fetch()` through the binding, matched by method and path like an
external's. Each call is one effect, `Service:<binding>`, with the faults of
a Durable Object stub call: `crash_before` and `error` mean the call never
reached the callee, `ambiguous` that it acted and the answer was lost,
`crash_after` that the caller died after it. Cloudflare retries none of
them. Every verdict states that callees were scripted.

Or the Worker behind the binding runs for real: the `callee` setup names
its module and wrangler config, and the `name` in that config qualifies
its bindings (`orders/DB`) in setup steps, effect targets, state queries
and snapshots. Each call through the binding is still one effect, now
hosting the callee's invocation (`<caller invocation>/<binding>.<method>`):
the entrypoint is constructed anew with the callee's `env`, its effects are
recorded under its own invocation and take faults by their position in it,
what it throws reaches the caller as RPC carries it (name, message, a
built-in class as itself), and a fault that crashes it is an error thrown
from the call. The call's own faults are a call's: `crash_before`,
`ambiguous`, `crash_after`. A test gives the platform the callee's name and
module exports (`callees: { ORDERS: { name: "orders", exports, props } }`;
`props` is what the caller's binding carries and the callee reads from
`ctx.props`) and an
`env` holding its bindings under their qualified names, which the caller's
wrangler config may declare as such (`"binding": "orders/DB"`). `eutaxy
check` does this itself: it reads each callee's wrangler config (JSON or
JSONC), generates a main module that re-exports the caller's exports and
the callees' Durable Object and Workflow classes under qualified aliases,
and adds the callees' D1 databases, R2 buckets, KV namespaces, Durable
Object namespaces, Workflows, queue producers, service bindings and vars
to the test's isolate under their qualified names. A resource both configs
name (the same database or bucket; a Durable Object class one Worker binds
from the other's script) is one resource, set up and snapshotted under the
caller's binding, the callee's an alias of it (the platform's `aliases`
option, which the command derives). A callee's Workflow runs the callee's
class with the callee's env; a callee's own service bindings are scripted
or further callees.

### Background work

Work passed to `ctx.waitUntil` runs after the handler returns and never
affects the acknowledgement or the response. The `cut_off` fault at that
point loses work not yet started, and an effect in flight commits without
its continuation.

### Durable Objects

Eutaxy does not re-implement Durable Objects: the objects are the ones
workerd runs, so storage, transactions, coalesced writes,
`blockConcurrencyWhile` and the input and output gates are the runtime's
own. Each stub call (a method, or an awaited RPC property) is one effect:
`crash_before` and `error` mean the call never reached the object,
`ambiguous` that the object committed and the answer was lost, and
`crash_after` that the caller died after the call. A crash inside the
object's own work resets it with `ctx.abort()`.

Objects are cleared, seeded from the `durableObject` setup and evicted
before each run, so they start from storage alone, and their storage is
snapshotted after it. In a concurrent run, an object's own outbound I/O
during a call is a turn, so another call may enter the object meanwhile, as
its open input gate allows; storage operations are not turns.

**Work after the answer.** Work an object starts and does not await (a
promise left running, as an agent runs a job after accepting it; a timer it
set; `ctx.waitUntil`) goes on after its answer, as the runtime keeps the
object alive while anything of its is pending. It runs as an invocation of
the object's own, `DO:<binding>/<object>/after`, whose effects are turns of
their own and take faults by their position in it, until nothing of it can
move or a crash resets the object, which ends it with the instance (the
next instance's work is `/after#2`). A sequential run lets it run to rest
before the next event; a concurrent run explores the other orders, a second
call entering the object while the first's work awaits its model among
them, which is where a lost update in such work hides. The timing of the
work around the answer does not matter to the model: an object that awaits
a timer of its own before answering is woken by it; an effect it issued
before its answer and did not await, like a timer it set or real work it
started (a digest), is the object's once the call has answered, so the
caller's crash does not end it and a fault in it resets the object, not the
caller; and a crash injected into an effect the object makes during a call
crashes the call and resets the object.

**SQLite storage.** For a SQLite-backed class (`new_sqlite_classes` in the
wrangler migrations, the backend Cloudflare recommends and the Agents SDK
requires), the setup seeds SQL storage too: `durableObject("INVENTORY", {},
{ sql: { "store-1": { schema: "CREATE TABLE stock (…)", rows: { stock: [{
sku: "widget", qty: 1 }] } } } })` creates the tables and inserts the rows
after the clear, which drops SQL and key-value data alike. The snapshot
lists every user table of a reached object with its rows under
`<object>/<table>`, beside the key-value rows under the object's name;
`durableObjectTable("INVENTORY", "store-1", "stock")` selects one for a
state invariant, as `durableObjectRows` selects the key-value rows.
`ctx.storage.sql.exec`, `transactionSync` and the synchronous
`ctx.storage.kv` are held by the input gate like key-value calls and are
not turns; nothing is recorded for them. A `sql` seed for a class that is
not SQLite-backed fails the reset, naming the migration to add; an
object's or a table's name may not hold `/`. An object the run never
reached shows the tables as the reset read them back after seeding,
defaults and generated values included.

**Agents.** A class built on the Agents SDK runs as written: its state and
schedules live in the SDK's own tables of the object's SQLite storage
(`cf_agents_*`, listed in the snapshot like any user table), a schedule
fires over the object's alarm in virtual time, and `routeAgentRequest`
walks the Worker's bindings as it does in production, the Vitest plugin's
own bindings hidden from it. The corpus's `agent-tally-lost-update` is an
Agent with state, `this.sql` and a schedule, caught losing an update.

**WebSockets.** `websocket([{ path: "/agents/room/r-1", messages: [{ data:
{ text: "hi" } }] }, …])` drives the Worker over WebSocket connections:
each is opened with an upgrade request through the Worker's `fetch` (one
event), which hands it to a Durable Object, and its messages are sent in
order (one event each). A message is delivered inside the object by calling
its `webSocketMessage` handler (the Hibernation API; the Agents SDK uses
it), with an alarm's faults; a crash drops the instance and the connection
survives, found again in the next instance by the attachment and tags the
object gave it. Opens run one at a time, in order; messages of different
connections interleave, so a race between two connections' messages is
explored. A connection the object closed takes no more messages (each is
recorded as not delivered). What the object sends back is recorded per
connection at the end of the run, in arrival order, as
`WebSocket:<connection>` `message` effects (`webSocketReceived` selects
them), and a close the object made as a `close` effect. The connections
are torn down after the snapshot, outside the run: what `webSocketClose`
does is not modelled. A connection the Worker answers itself, an object
using the standard WebSocket API, or one on `setWebSocketAutoResponse`,
makes the run `UNSUPPORTED`. The corpus's
`agent-room-lost-update` is a chat-room Agent over two connections, caught
losing an update between them.

**Alarms** fire in virtual time: Eutaxy takes them over so none is
scheduled on the real clock. One alarm per object, a later `setAlarm`
replaces it, one set inside a transaction applies on commit, and it
survives eviction. `alarm()` is one effect, and a failed alarm is retried
after 2 s, 4 s, 8 s, up to six retries and `maxRedeliveries`, with
`retryCount` and `isRetry`. Several schedules over one alarm (the pattern
the Agents SDK uses) work as written. An object that keeps re-arming fires
at most `alarmsPerObject` times per run (default 3).

### R2

Each `put`, `delete`, `get`, `head` and `list` is one effect; writes take
every fault, reads all but `ambiguous`. A body is read inside its `get`, and
an object's random `version` and wall-clock `uploaded` are replaced with
stand-ins so traces repeat exactly. A conditional `put` whose precondition
fails stores nothing and returns `null`.

### Workflows

The local Workflows engine runs steps on its own real-time clock, so it
cannot be restarted between a step committing and its result being
persisted, which is the case that matters. Here the engine is a model, the
one exception to running the real local implementation, and the corpus
checks it against the local engine on fault-free runs.

An instance runs your own class. Each `step.do` attempt is two effect
points around its callback: a crash before the step restarts the instance
before it runs; a crash after it means the step ran and committed but its
result was not persisted, so it runs again after the restart; `ambiguous`
is an attempt that ran but counted as failed, as a timeout does. A failed
attempt is retried after its delay in virtual time (by default 5 retries,
10 s apart, exponential), except a `NonRetryableError`. A restart re-runs
`run()` from the start with the persisted step and sleep results, so code
outside steps repeats. `step.sleep` and `step.sleepUntil` wait in virtual
time.

`step.waitForEvent` and `instance.sendEvent` are modelled as documented: an
event sent before the wait is buffered and returned at once; a wait with no
event suspends the instance (status `waiting`) until the event or its
deadline (default 24 hours, in virtual time) wakes it, when the wait throws
the catchable `WorkflowTimeoutError`. The suspension is not an error: a
`catch` around the wait sees only that timeout, and nothing after the wait
runs until the instance wakes. Resuming re-runs `run()` with the
persisted results, so code outside steps repeats here too, and the wait's
result is replayed, not consumed again.

## What makes a run `UNSUPPORTED`

Eutaxy refuses to pass a run it cannot control:
- A service binding without its `service` setup step, a method its script
  lacks, an unmatched `fetch()` through it, a redirect reply the runtime
  would follow, `connect()`, or RPC promise pipelining on its calls.
- A binding outside the allowlist: the Cache API, AI,
  Hyperdrive, raw sockets, KV.
- A request to a host no external declares, or one no scripted response
  answers.
- `WeakRef` and `FinalizationRegistry`, which are not virtualised.
- An invocation waiting on something Eutaxy cannot see, or an effect whose
  real I/O outlasts the budget.
- Durable Objects: an object reached only through another object's binding,
  `jurisdiction()` namespaces (and `newUniqueId` with a jurisdiction), a
  namespace without a `durableObject` setup, a result that is not plain data (an RPC
  capability), `setAlarm` inside `transactionSync()`.
- R2: multipart uploads, conditions on the upload time, a bucket without an
  `r2Bucket` setup.
- Workflows: rollback handlers, `createBatch`,
  pausing, resuming, terminating or restarting an instance, and a binding
  without a `workflow` setup.

Production-only behaviour the simulator cannot see, such as D1 read
replication, real queue batching and real latency, is out of scope.

## Running inside workerd

The engine relies on three documented properties of the Cloudflare Vitest
integration, and names them as assumptions in every verdict:
1. The main Worker runs in the same isolate as the test, so the engine's
   global patches apply to it.
2. Storage isolation is per test file, so the engine resets bindings and
   Durable Object memory between runs itself.
3. Module state cannot be reset, so before `BOUNDED` the first runs are
   replayed in reverse order and any difference is `UNSUPPORTED`
   (`module_state_leak`).

To run a check from your own test suite instead of the CLI, `expectHolds`
and `check` from `eutaxy/cloudflare` take a scenario and a platform built
with `createCloudflarePlatform`, as the generated regression tests do.

## Effect conventions

What the proxies record, and what [selectors](/guide/invariants) match:

| Target               | Op                                       | Payload                                                                                                    |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `D1:<binding>`       | `run`, `batch`, `first`, `all`, `raw`, `exec` | `{ args: { sql, params } }`; a write's result adds `result: { changes, lastRowId }`                        |
| `Queue:<name>`       | `ack`, `retry`                           | `{ args: { messageId, body, implicit? } }`; the result's `effective` is false when an earlier decision won |
| `Queue:<name>`       | `dead_letter`                            | `{ args: { messageId, attempts } }`                                                                        |
| `Http:<path>`        | `response`                               | `{ args: { requestId, method, path } }`; result `{ status, ok, body }`                                     |
| `Http:<path>`        | `gave_up`                                | `{ args: { requestId, attempts } }` when the caller's retries are spent                                    |
| `Queue:` / `Http:`   | `background`                             | `{ args: { pending } }` after the handler returned with `waitUntil` work; the only point taking `cut_off`  |
| `Fetch:<external>`   | the HTTP method                          | `{ args: { url, method, headers, body, dedupeKey } }`; result `{ status, effective, dedupeKey }`           |
| `DO:<binding>`       | the method or property name; `alarm`     | `{ args: { object, args } }` for a call, `{ args: { object, property: true } }` for an awaited property    |
| `R2:<binding>`       | `put`, `delete`, `get`, `head`, `list`   | the key and options; `put`'s result has `stored`, false when `onlyIf` failed                               |
| `Workflow:<binding>` | `create`, `step`, `step_result`, `sleep` | the instance and the step; a failed attempt's result carries its error                                     |
| `Core:<function>`    | `decide`                                 | `{ args, result }` for each call into a core module the scenario lists in `specs`                          |

Snapshots are recorded after the last event under the binding's target,
with kind `snapshot`.
