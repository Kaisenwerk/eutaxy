---
description: How to write an Eutaxy scenario for a Cloudflare Worker - queue, HTTP, RPC and cron drives, caller retry policies, setup for D1, Durable Objects, R2 and Workflows, declared externals, bounds and core specs.
---

# Scenarios

A scenario is a TypeScript file, by convention `name.sim.ts` beside the
Worker, whose default export is built with `defineScenario` from
`eutaxy/cloudflare`. It is plain data: the Worker, how to drive it, the
state to set up before each run, the services it talks to, what must hold,
and the bounds of the search.

```ts
import { d1Schema, defineScenario } from "eutaxy/cloudflare";

export default defineScenario({
  name: "payments", // also the default seed
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  drive: payments, // queue(...) or http(...)
  setup: [d1Schema("DB", "./schema.sql")], // d1Schema, durableObject, r2Bucket, workflow
  externals: [paymentsApi], // external(...) per host the Worker fetches
  invariants: [recordedOnce, noneLost], // what must hold; see Invariants
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
  specs: [
    /* modules of the pure core with spec files beside them */
  ],
});
```

`defineScenario` validates the scenario and throws with every problem
listed. The name is lowercase letters, digits and dashes, and at least one
invariant is required. Paths are relative to the scenario file.

## Drives

A scenario has one drive: the events that invoke the Worker.

### `queue(name, messages)`

Drives the Worker's `queue()` handler with these messages, one invocation
per delivery attempt. Delivery is at least once, as Cloudflare Queues
documents: a message neither acknowledged nor retried is redelivered up to
the consumer's `max_retries` (from the wrangler config, default 3) and the
scenario's `maxRedeliveries`, then dead-lettered, which the log records.

```ts
const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { id: "late", body: { orderId: "o-2", amountCents: 500 } }, // id defaults to msg-<n>
]);
```

### `http(requests, caller)`

Drives the Worker's `fetch()` handler. Each request is an event delivered
under the same faults as a message; the response the handler returns is
recorded as an effect (`Http:<path>`, op `response`), and an uncaught
exception is a 500.

Cloudflare never retries an inbound request; the caller does. The second
argument is that caller's policy:

```ts
const webhooks = http(
  [
    { path: "/webhooks/payment", headers: { "Idempotency-Key": "evt-1" }, body: { id: "evt-1" } },
    { method: "GET", path: "/orders/o-1" },
  ],
  {
    retries: 3, // resends after the first attempt (default 3; a browser-like caller has 0)
    retryOn: "non-2xx", // or "5xx": what counts as failed (default "non-2xx")
    delaysMs: [1000, 5000], // virtual wait before each resend; the last entry repeats
    deadlineMs: 10_000, // how long the caller waits for an answer before counting it failed
  },
);
```

`method` defaults to POST with a body and GET without; a JSON `body` is
sent as `application/json`. With a deadline, the caller decides at the
response point or at its deadline, whichever comes first, so a resend can
start while the first attempt is still running.

### `rpc(calls, caller)`

Drives a `WorkerEntrypoint` with method calls. The entrypoint is the
Worker's default export (pass the class as `handler`) or a named export
(`entrypoint`, found among the module's `exports`). Each call is an event;
each attempt constructs the entrypoint anew, as the runtime does, calls the
method, and records the return value as the response (`Rpc:<method>`, op
`response`, `{ ok: true, value }`) or the exception as the error the caller
sees (`{ ok: false, error }`, its name and message).

```ts
const calls = rpc(
  [
    { method: "reserve", args: ["o-1", 2] },
    { id: "lookup", method: "reservation", args: ["o-1"] },
  ],
  {
    retries: 2, // resends after a call that threw or got no answer (default 0: a calling Worker resends only when written to)
    delaysMs: [1000], // as for http()
    deadlineMs: 5000, // as for http()
    entrypoint: "Inventory", // a named export; omit for the default export
  },
);
```

Cloudflare never retries an RPC call; the caller you declare does. A
return value that is not plain data (a stub, a function, a stream) makes
the run `UNSUPPORTED`. `rpcResponse(method, { ok })` selects the answers
for invariants, and `atLeastOncePerMessage` reads each call's arguments by
path (`"0.orderId"`).

### `cron(expression, options)`

Drives the Worker's `scheduled()` handler with the ticks of a Cron
Trigger: the expression's first matches from the virtual epoch on, in UTC,
each an event delivered at its virtual time. The handler sees
`controller.scheduledTime` as the tick's time, `controller.cron` as the
expression, and `Date.now()` at that minute.

```ts
const reconcile = cron("*/5 * * * *", {
  ticks: 3, // how many ticks to drive (default 1)
  retries: 1, // re-runs of a tick whose handler failed (default 0)
});
```

Cloudflare documents `controller.noRetry()` but no retry count for a failed
invocation, so the re-runs are yours to declare; a handler that called
`noRetry()` is not re-run. Cloudflare's dialect is parsed as documented
(weekdays run 1 = Sunday to 7 = Saturday; names, lists, ranges and steps);
`L`, `W` and `#` are refused.

## Setup

Setup steps run before every run, so each run starts from the same state.

| Step                                                    | Does                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `d1Schema(binding, "./schema.sql")`                     | Drops every user table in the D1 binding and applies the schema                                      |
| `durableObject(binding, objects?, { alarmsPerObject })` | Clears the namespace, seeds the named objects' storage, evicts them; snapshots storage after the run |
| `r2Bucket(binding, objects?)`                           | Empties the bucket and seeds these objects; snapshots it after the run                               |
| `workflow(binding, className, { name })`                | Names the class (an export of the Worker module) a Workflow binding's instances run                  |
| `service(binding, { methods, fetch })`                  | Scripts the Worker behind a service binding: each method's reply, the replies to `fetch()`; never calls it |

A Durable Object namespace, R2 bucket, Workflow binding or service binding
the Worker uses without its setup step makes the run `UNSUPPORTED`: state
left over from one run would leak into the next, and a real peer would be
called.

A service binding's script names each method's reply, a value returned or
an error thrown to the caller, and the replies to `fetch()` through the
binding, matched by method and path like an external's:

```ts
const billing = service("BILLING", {
  methods: {
    charge: { returns: { chargeId: "ch-1" } },
    refund: { throws: "RangeError: already refunded" },
  },
  fetch: [{ method: "GET", path: "/health", status: 204 }],
});
```

Each call is one effect (`Service:<binding>`, the method as op) with the
faults of a Durable Object stub call: the call never reached the callee, it
acted and the answer was lost, or the caller died after it.
`serviceCall(binding, method)` selects the calls for invariants. See
[Cloudflare Workers](/platforms/cloudflare) for what each binding models.

## Externals

Outbound `fetch` never reaches the network. Every host the Worker talks to
is declared, with scripted replies and what the service guarantees under
retries:

```ts
import { external, fetchCall } from "eutaxy/cloudflare";

const paymentsApi = external("payments-api", "api.payments.example", {
  dedupeBy: "Idempotency-Key",
  responses: [
    { method: "POST", path: "/v1/charges", status: 201, body: { id: "ch_1" } },
    { path: "/v1/*", status: 404 },
  ],
});
```

- `host` is exact or a suffix pattern such as `*.example.com`.
- The first matching response answers a request; `path` ending in `*` is a
  prefix. With no `responses`, every request gets 200 and an empty body;
  with some, a request none matches makes the run `UNSUPPORTED`.
- `dedupeBy` names the header that makes a request idempotent at the
  service: a request repeating an earlier key gets the earlier reply and is
  recorded as not effective, so `fetchCall("payments-api", "POST")` counts
  only requests that took effect.
- A request to an undeclared host makes the run `UNSUPPORTED`.

Each request is an effect point with every fault available, including the
ambiguous one where the service acted but the Worker saw an error. The
declarations are listed among the verdict's assumptions.

## Bounds

| Bound                      | Default | Meaning                                                                            |
| -------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `maxFaultsPerRun`          | 1       | Faults injected in one run                                                         |
| `maxRedeliveries`          | 2       | Redeliveries of one event: a message, an alarm, a step's retries, a resent request |
| `maxConcurrentInvocations` | 1       | Invocations in flight at once; above 1 they interleave at their I/O                |
| `budgetMs`                 | 2000    | Time budget for exploration; also how long one effect's real I/O may take          |

A time budget makes the number of runs depend on the machine, so CI and
tests that assert a verdict pass `--budget-ms` with a generous value and
`--max-runs` to cap the runs. Every verdict reports the bounds it reached.
See [Faults and exploration](/guide/faults).

## Concurrency

With `maxConcurrentInvocations` above 1, up to that many invocations are in
flight at once, as concurrent requests are in one isolate and queue
consumers are up to `max_concurrency`. Each asynchronous effect is a point
where another invocation may run first. This is how lost updates show up:
two invocations read the same row, both decide, both write.

```ts
bounds: { maxConcurrentInvocations: 2, maxFaultsPerRun: 0 },
```

## Core specs

`specs` names the modules of the Worker's pure core, relative to the
scenario. While the scenario runs, calls into their functions are recorded,
each property in the spec file beside the module is checked on those
inputs, and the calls become decisions that the
[`refines`](/guide/invariants#refines) invariant compares the Worker's
effects against.

```ts
specs: ["./domain.ts"], // its properties live in ./domain.props.ts
```

See [Specs](/guide/specs).
