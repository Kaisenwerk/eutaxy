---
description: How Eutaxy simulates Cloudflare Workers - D1, Queues, inbound HTTP and RPC, outbound fetch, Durable Objects with alarms, R2 and Workflows, the documented semantics each follows, the effects each records, and what makes a run UNSUPPORTED.
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
| Inbound HTTP      | the `http` drive  | the response                                  | One invocation per attempt; an uncaught exception is a 500; the declared caller decides resends                  |
| Inbound RPC       | the `rpc` drive   | the response                                  | One invocation per call attempt, the entrypoint constructed per call; an exception is the error the caller sees  |
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
  `newUniqueId`, `jurisdiction()` namespaces, a namespace without a
  `durableObject` setup, a result that is not plain data (an RPC
  capability), `setAlarm` inside `transactionSync()`.
- R2: multipart uploads, conditions on the upload time, a bucket without an
  `r2Bucket` setup.
- Workflows: `waitForEvent`, `sendEvent`, rollback handlers, `createBatch`,
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
