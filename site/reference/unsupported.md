---
title: UNSUPPORTED reasons
description: Every reason a check reports UNSUPPORTED, what it means and what to do about it - the run reached something outside the model, which is never a pass.
---

# `UNSUPPORTED` reasons

A check is `UNSUPPORTED` when a run reached something Eutaxy does not
model, so it cannot say whether the invariants hold. It is never a pass:
the command exits 2, and the report names the cause and the reason. This
page lists every reason the code can give, in the words the report uses
(a name in angle brackets, `<binding>`, stands for the name in your
scenario), with what it means and what to do. A test keeps the page and
the code in step: a reason the code can give that is not here fails it.
Which of these the model will close, and which stay by design, is in the
[roadmap](/reference/roadmap) under the patch work and the candidates.

The verdict's `cause` sorts the reasons:

| Cause                | Means                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `unsupported_api`    | the Worker used something outside the model; most reasons below                             |
| `unsupported_bounds` | the scenario's bounds ask for something the platform or the runtime cannot do               |
| `not_replayable`     | a run did not repeat when replayed with the same seed and faults                            |
| `module_state_leak`  | a run gave a different log when replayed after other runs: state survives between runs      |

## Bounds, replay and leaks

**`maxConcurrentInvocations above 1 needs AsyncLocalStorage (Node, or workerd with nodejs_compat or nodejs_als)`**
Concurrent invocations are told apart by async context. Add the
`nodejs_compat` (or `nodejs_als`) compatibility flag to the wrangler
config, or set `maxConcurrentInvocations: 1`.

**`maxConcurrentInvocations above 1 is not supported on the <platform> platform yet`**
The platform (AWS today) runs one invocation at a time. Set
`maxConcurrentInvocations: 1`.

**`exhaustive exploration needs deterministic runs: <what differed>`** and
**`the violating run of seed <seed> did not reproduce on replay: <what differed>`**
The same schedule gave two different runs. Something the Worker does is
not under Eutaxy's control: real I/O outside the declared externals, a
clock or random source read through an API Eutaxy does not patch, or work
that finishes in real time. The reason names what differed; route that
input through a binding or an external. If it is Eutaxy's own, report it.

**`run seed <seed> produced a different log when replayed after other runs: state is leaking between runs (module-level variables, or a binding Eutaxy does not reset); <what differed>`**
Before it reports `BOUNDED`, a check replays its first runs in reverse
order. A module-level variable (a cache, a counter, a client holding
state) or a binding without a setup step carried something from one run
into the next. Keep such state in a binding the scenario sets up, reset it
in the handler, or create it per request. A Durable Object's in-memory
fields are reset with the object; a module's are not. Both reasons end
with the first record the replay recorded differently (or the two logs'
lengths), and a replay that itself reached something unsupported reports
that reason instead.

## Setup and bindings

**`binding <name> is not proxied`**
The Worker touched a binding of a kind the simulation does not model (KV,
Workers AI, Vectorize, Hyperdrive, a Queue producer and others; the
[Cloudflare page](/platforms/cloudflare) lists what is). Keep that path
out of the scenario, or put the binding behind a service binding the
scenario scripts with `service()`.

**`R2 binding <name> needs an r2Bucket() setup step, which empties it before each run`**,
**`Workflow binding <name> needs a workflow() setup step naming its class`**,
**`service binding <name> needs a service() setup step scripting the Worker it reaches`**,
**`Durable Object binding <binding> has no durableObject setup, so its objects are not reset between runs; add durableObject("<binding>") to the scenario's setup`**
Every modelled binding the Worker uses needs its setup step, which
resets it before each run and tells the platform what it is. Add the step
the reason names. `eutaxy draft` writes them from the wrangler config.

**`Durable Object binding <binding> needs the Cloudflare test helpers (pass durableObjects to createCloudflarePlatform)`**
Durable Objects are reset and inspected through `cloudflare:test`. `eutaxy
check` passes it; in your own Vitest test, pass
`createCloudflarePlatform({ ..., durableObjects })` with
`import * as durableObjects from "cloudflare:test"`.

**`callee <name>: the platform was not given its module; pass createCloudflarePlatform({ ..., callees: { <name>: { name, exports } } }), as eutaxy check does from the callee() step`**
A `callee()` step names the Worker, but the platform has no module to run.
Run the scenario with `eutaxy check`, or pass the callee's module in your
own test.

## D1 and R2

**`D1 <binding>.<method> is not modelled`**
A D1 method outside `prepare`, `batch`, `exec` and their statements'
`run`, `first`, `all` and `raw` (sessions, `dump`). Keep it out of the
scenario's path.

**`R2 <binding>: conditions on the upload time are not modelled`**
An `onlyIf` with `uploadedBefore` or `uploadedAfter`: an object's upload
time is a stand-in, so traces repeat. Condition on the etag instead.

**`R2 <binding>: createMultipartUpload() is not modelled`**,
**`R2 <binding>: resumeMultipartUpload() is not modelled`**
Multipart uploads are not modelled; a scenario can drive the single-`put`
path.

## Durable Objects and alarms

**`Durable Object <binding> <object> was reached without a call Eutaxy saw (through another object's binding); calls between objects are not proxied yet`**
One object called another through its own `env`. Calls between objects
are not effects yet; drive the second object from the Worker in the
scenario.

**`Durable Object <binding> <object> called the service binding <name> through its own env: an object's own binding calls are outside the simulation, so no service() script or callee() answers them`**
The runtime hands an object the Worker's real `env`, where a service
binding is not the scenario's script or callee. The call would fail or
answer unseen, and an object that catches the error would carry on as if
the peer had refused. Until an object's own calls are effects, make the
call from the Worker and pass the answer in, or give the object its
answers from a subclass in the scenario's entry module.

**`Durable Object <binding> <object> returned something that is not plain data (an RPC capability or an object with methods); calls on it would bypass Eutaxy`**
A method returned a stub, a function or an object with methods. Return
plain data, and call the object again for more.

**`Durable Object <binding> <object>: RPC promise pipelining (reading .<property> on a call's promise) is not supported; await the call first`** and
**`Durable Object <binding> <object>: RPC promise pipelining (reading .<property>.<key>) is not supported; await .<property> first`**
`stub.method().field` without an `await` in between. Await the call, then
read the field.

**`<binding>.newUniqueId({ jurisdiction }) ids are not proxied or reset; use newUniqueId() without one`**
A unique id restricted to a jurisdiction lives in a jurisdiction namespace,
which the setup does not reset. Plain `newUniqueId()` is modelled: the id
is drawn from the run's seed, so it repeats on replay.

**`<binding>.jurisdiction() namespaces are not proxied or reset; use the namespace itself`**
A jurisdiction-restricted namespace is a second namespace the setup does
not reset. Drive the namespace itself in the scenario.

**`Durable Object <binding> <object> set an alarm but has no alarm() handler`**
The object called `setAlarm` but defines no `alarm()`. Add the handler, or
do not set the alarm.

**`Durable Object <binding> <object>: its constructor read the alarm while one was pending; natively it would have seen that alarm, so constructors that read the alarm are not modelled`** and
**`Durable Object <binding> <object>: its constructor set an alarm while one was pending; natively it would have seen that alarm, so constructors that read the alarm are not modelled`**
The constructor reads or sets the alarm (an Agents SDK class does this
for its schedules) while an alarm is pending. Read it in the handler that
needs it, not in the constructor.

**`Durable Object <binding> <object>: <operation> inside transactionSync() is not modelled`**
An alarm operation inside `ctx.storage.transactionSync()`. Set the alarm
after the transaction.

## WebSockets

**`WebSocket <connection>: the Worker answered the upgrade itself; only connections a Durable Object accepts are modelled`**
The Worker accepted the WebSocket itself. Hand the upgrade to a Durable
Object that accepts it with `ctx.acceptWebSocket`.

**`WebSocket <connection>: the object accepted no WebSocket with the Hibernation API (ctx.acceptWebSocket); the standard API is not modelled`**
The object used `ws.accept()`. Use the Hibernation API.

**`WebSocket <connection>: <n> sockets were accepted by <object> during this open, so this connection's cannot be told apart`**
One upgrade accepted several sockets. Accept one per upgrade.

**`WebSocket <connection>: the connections <ids> of <object> cannot be told apart after its instance was dropped; give each socket an attachment or a tag`**
After a crash the object's instance is rebuilt and its sockets found
again; with nothing on them to tell them apart, the connections cannot be
matched. Give each socket a `serializeAttachment` or a tag.

**`Durable Object <binding> <object> uses setWebSocketAutoResponse, which is not modelled`**,
**`Durable Object <binding> <object> has no webSocketMessage handler; only the Hibernation API is modelled`**
Answer in `webSocketMessage` instead.

**`a Durable Object made a request while its WebSocket connections were torn down after the run; what webSocketClose does is not modelled`**
After the run Eutaxy closes the connections; the object's close handler
then made a request. Keep `webSocketClose` to storage, or out of the
scenario's objects.

## Service bindings, callees and RPC

**`service binding <binding>: no scripted reply for method <method>; add it to the service("<binding>") setup's methods`** and
**`service binding <binding>: no scripted reply for fetch <method> <path>; add it to the service("<binding>") setup's fetch`**
The scripted Worker was asked something its `service()` step does not
answer. Add the reply, or run that Worker with `callee()`.

**`service binding <binding>: the scripted reply to <method> <path> is a <status> redirect, which the runtime would follow; script the final reply or fetch with redirect: "manual"`**
Script the reply the redirect leads to.

**`service binding <binding>: RPC promise pipelining (reading .<property> on <method>()'s promise) is not supported; await the call first`** and
**`service binding <binding>: RPC promise pipelining (reading .<method>.<key>) is not supported; await .<method> first`**
Await the call, then read the field.

**`service binding <binding>: connect() (a raw TCP socket) is not modelled`**
Keep TCP sockets out of the scenario's path.

**`callee <binding>: the arguments of <method> are not plain data (a stub, a function, a stream or a class instance); RPC carries plain data only`**,
**`callee <binding>: the arguments of <method> cannot be copied as RPC copies them`**,
**`callee <binding>: <method> returned something that is not plain data (a stub, a function or a stream); RPC capabilities are not modelled`**
Pass and return plain data across the binding.

**`callee <binding>: the default export of <worker> is not a WorkerEntrypoint class`** and
**`callee <binding>: export <name> of <worker> is not a WorkerEntrypoint class`**
The binding reaches an entrypoint that is not a `WorkerEntrypoint`
subclass. Check the binding's `entrypoint` and the module the `callee()`
step names.

**`callee <binding>: <worker> has no fetch handler`**,
**`callee <binding>: <worker>'s fetch handler returned something that is not a Response`**,
**`callee <binding>: <worker> answered <method> <path> with a <status> redirect, which the runtime would follow; fetch with redirect: "manual"`**
The caller used `fetch()` through the binding; the callee must answer it
with a `Response`, and a redirect is followed by the runtime.

**`Rpc <method>: the result is not plain data (a stub, a function or a stream); RPC capabilities are not modelled`**
The Worker the `rpc()` drive calls returned something RPC would pass as a
capability. Return plain data.

**`Rpc: the Worker's default export is not a WorkerEntrypoint class; pass the Worker module's exports as createCloudflarePlatform({ ..., exports })`**
The `rpc()` drive needs the class. `eutaxy check` passes it; in your own
test, pass the module's exports.

## Workflows

**`Workflow <binding>: pause() is not modelled`** (and `resume()`,
`terminate()`, `restart()`, `delete()`, `subscribe()`, `createBatch()`,
`deleteBatch()`)
Instance management beyond `create`, `get`, `status` and `sendEvent`.
Keep it out of the scenario's path.

**`Workflow <binding>: step.do started alongside step.waitForEvent; steps running in parallel with a wait are not modelled`**
(also `step.waitForEvent` and `step.sleep`) A step was started while a wait
was pending, from code running in parallel with it (`Promise.all` of a
wait and a step). The engine runs such a step while the wait is pending;
the model does not. Wait first, then run the step, or run the step first.

**`Workflow <binding>: rollback handlers are not modelled`**
A `step.do` with a `rollback`. Leave it out of the scenario's Workflow.

**`Workflow <binding>: Step name "<name>" exceeds max length (256 chars) or invalid characters found`** and
**`Workflow <binding>: Step config for "<name>" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/`**
The engine's own checks, which fail the instance with a fatal error whose
catching is not documented. Fix the step's name or config.

**`Workflow <binding>: step "<name>" returned a value that is not structured-cloneable (a ReadableStream is not modelled)`** and
**`Workflow <binding>: step "<name>" returned more than about 1 MiB, which the engine refuses ("output is too large"); Eutaxy cannot measure the stored size exactly`**
Return plain data from steps, and keep large outputs in R2.

**`Workflow <binding>: step "<name>"'s retry delay function threw (<error>)`**
The step's `retries.delay` function threw. Fix it.

**`Workflow <binding>: step.sleepUntil "<name>" replayed after its time, where Miniflare's engine throws`**
A `sleepUntil` whose time passed before a restart reached it again: the
engines disagree, so it is reported. Sleep for a duration instead.

**`Workflow <binding>: waitForEvent "<name>" timeout must be between 1 second and 365 days`**
Give the wait a timeout in that range.

**`Workflow <binding>: event.workflowName needs the Workflow's name, workflow(binding, className, { name })`**
The code reads `event.workflowName`. Pass the Workflow's `name` from the
wrangler config to the `workflow()` step (`eutaxy draft` does).

**`Workflow <binding>: run() returned a value that is not structured-cloneable`**
Return plain data from `run()`.

**`Workflow <binding>: class <class> is not among the Worker module's exports; pass them as createCloudflarePlatform({ ..., exports })`** and
**`Workflow <binding>: class <class> is not among the exports of the callee <worker>`**
The `workflow()` step names a class the module does not export. Check the
class name, and that the module exports it.

## Externals, timing and the core

**`fetch to undeclared host <host>; declare it as an external in the scenario`**
Outbound `fetch` never reaches the network. Declare the host with
`external(name, host, { responses })`; `eutaxy draft` declares each host
the code fetches by a literal URL.

**`no scripted response in external <name> for <method> <path>`**
The external has no reply for that request. Add one to its `responses`.

**`external <name> answers <method> <path> with a <status> redirect; script the final reply or fetch with redirect: "manual"`**
Script the reply the redirect leads to.

**`<target> <op> did not complete within <budget> ms of real time`**
An effect's real I/O (a D1 statement, an R2 call) took longer than the
scenario's time budget. Raise `budgetMs` (or `--budget-ms`) if the
machine is slow; if it never completes, the code is waiting on itself.

**`DO:<binding>/<object>/after: the object's work after its answer fired its timers <n> times and does not settle (an interval or a timer that re-arms itself); the model waits for such work only up to 100 firings without it settling`**
Work a Durable Object goes on with after answering runs as the object's
own invocation until nothing of it can move. A heartbeat never settles:
an interval, or a timeout that sets itself again. The runtime would run
it until the object is evicted, which a run cannot wait for, so the run
stops waiting after 100 firings without the work settling, whichever
wait fired them, and the object's work ends (the count starts over each
time the work settles, so an object that sleeps once per call is not a
heartbeat). Give the
heartbeat an end the scenario reaches, or move it to an alarm, which the
model fires a bounded number of times (`alarmsPerObject`).

**`invocation <id> is waiting on something Eutaxy cannot see (no effect in flight, no timer due)`**
The handler is awaiting a promise nothing will settle: a real timer or
I/O the simulation does not drive, or an event that never comes. Find
what it awaits; route it through a binding, an external or a timer.

**`core function <name> returned a promise; observed core functions must be synchronous and pure`**
A module listed in the scenario's `specs` exports an async function. The
specs cover the pure core; move the I/O out of it.

## AWS

**`no local client configured for <client class>; pass one in createAwsPlatform({ clients })`**
The handler used an AWS SDK client the platform has no local stand-in
for. Pass one (DynamoDB has one) or keep that client out of the path.

**`callback-style send(<command>, cb) is not modelled; await the promise form`**
Use `await client.send(command)`.
