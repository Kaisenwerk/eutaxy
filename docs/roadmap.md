# Roadmap

Phases are numbered after the release that closes them: phase v0.N ships
as `0.N.0` once its gate passes, and work toward it ships before that as
patch releases of the previous phase (work toward v0.5 ships as `0.4.x`).
Each phase is closed by a gate that must pass before the next starts. A
gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora grow with
every phase. The JSON report schema is versioned, so CI and coding agents
can rely on it.

## v0.4 — Simulator (released as 0.4.0, 2026-10-23)

- Scaffold: pnpm workspace with the eleven packages, declared dependencies
  mirrored by project references and checked against the design,
  `pnpm check` green, per-package READMEs, and the public hygiene files:
  README, LICENSE, CONTRIBUTING, CHANGELOG, code of conduct.
- Scenario spec format (`*.sim.ts`): Worker, scenario, declared externals,
  invariants and bounds, designed with the first planted bug as its first
  user.
- Bindings: D1 and Queues; outbound `fetch` with declared externals
  (`dedupeBy`, scripted replies).
- Drives: queue messages and inbound HTTP requests. An HTTP request is an
  event like a queue message: delivered with the same faults, redelivered
  on the caller's declared retry count (webhook providers retry, a
  browser does not), the response recorded as an effect. A crash at the
  response point is the case of a handler that committed but whose answer
  the caller never got. It is in this phase because the first real Workers
  to check enter through `fetch` handlers (payment and chat-platform
  webhooks, a sign-in endpoint with rate limits). One invocation runs at a
  time; concurrent requests come with v0.5.
- Faults: crash before, crash after, ambiguous outcome, error, redelivery,
  cut-off of `waitUntil` work.
- Scheduler: seeded exploration with a time-based budget.
- Invariants: `atMostOncePerKey`, `atLeastOnce`, `implies`, `everyRow`.
- Shrinker; text and versioned JSON report; Vitest regression emitter;
  `expectHolds` and `check` for use from a user's test suite; `eutaxy
  check` CLI with `--json`.
- Virtual clock and globals patching; module-state leak detection;
  published-package build and publish dry run.
- AWS platform spike: Lambda with an SQS event source and DynamoDB through
  the SDK `send` proxy, the differential runner. It is in this phase, not
  the self-check phase, because the Cloudflare path was useful end to end
  and the engine already had everything a second platform needs, so the
  spike doubles as the test that the layering holds. Not in scope yet: the
  `eutaxy check` command for AWS scenarios, other services (S3, SNS,
  EventBridge), SQS batches larger than one record.
- `examples/payments-queue`: the README quick start, runnable.
- Planted bugs: `queue-duplicate-write` (crash before ack),
  `queue-ack-then-write` (ack then write in `waitUntil`),
  `queue-random-id` (random row ids with `INSERT OR IGNORE`),
  `queue-charge-twice` (a charge without an idempotency key),
  `webhook-duplicate-record` (a webhook recorded twice on redelivery),
  `sqs-duplicate-put` (AWS).

**Gate:** every planted bug is caught, shrunk, replayed and emitted as a
regression test; the differential corpus shows no divergence from workerd;
the same seed produces a byte-identical trace twice. (Passed in CI.)

## v0.5 — Durable Objects and specs (current)

In this order:
- Concurrent invocations (`maxConcurrentInvocations` above 1) for every
  drive, interleaved at asynchronous effects by a seeded pick; planted
  bug `signin-code-rate-limit` (a limit checked with a read and then an
  insert). Done on the Cloudflare platform; the AWS platform still
  delivers one event at a time. First,
  because Durable Object gates only mean something with interleaved
  events, and the first real HTTP target (rate limits and an attempt cap
  on a sign-in endpoint) fails only under concurrent requests.
- HTTP caller timing: retry delays on the virtual clock and a response
  deadline, so a handler that commits but answers too late is redelivered
  while the first attempt may still run or hold a short lease. Both
  webhook targets need it: one provider gives up on an answer after a few
  seconds, the other is retried while a lease it answered 503 for is
  still held. Done: `delaysMs` and `deadlineMs` on the `http` drive;
  planted bug `webhook-lease-outlives-retries` (a lease that outlives the
  caller's resend window). Not yet: latency on scripted externals, so
  background work is slow in virtual time only when it waits on a timer.
- Durable Object storage (key-value and SQL, transactions), input and
  output gates, write coalescing, alarms; KV. First real target beside the
  wallet race: a lease pool that hands out at most one lease per slot and
  recovers a lease whose stub-call response was lost after the object
  committed (a call inside one Worker; service-binding RPC between Workers
  is not needed for it); and an object that multiplexes several schedules
  over its one alarm (the pattern the Agents SDK uses), so alarm-driven
  state machines survive eviction. Done so far: the real objects behind a
  proxied stub boundary (faults at each call, reset and seed per run,
  storage snapshots, the `unique` invariant), planted bug
  `lease-pool-lost-response`. Next: alarms in virtual time; KV and SQL
  storage when a target needs them (the first target uses key-value
  storage only).
- Exhaustive scheduler and partial-order reduction.
- Lemma spec parser, `SpecIR`, the `CHECKED` rung, `refines`.

**Gate:** a planted rate-limit race under concurrent requests is caught;
the wallet race is caught; no false alarms on the Durable Object corpus;
the exhaustive enumerator's schedule count matches its closed-form
formula.

### v0.5.x

R2 and Workflows models.

## v0.6 — Provers

- `TESTED` rung; `Prover` interface, ladder and aggregation.
- First-party `prover-lean` engine on the initial subset (immutable data,
  algebraic types, structural recursion, bounded integers, quantifier-free
  arithmetic), with its contract corpus and translation validation; proof
  cache; `eutaxy prover install lean`.
- MCP server and GitHub Action over the JSON schema.

**Gate:** the first-party contract corpus passes against the pinned Lean
toolchain; the refund example reaches `PROVEN` with the first-party engine.

### v0.6.x

Optional Thales and LemmaScript adapters with their own contract corpora;
`CONFLICT` detection across engines.

## v0.7 — Self-check

Enumerator proven through a prover adapter; invariant checkers verified
against reference implementations; `eutaxy report`.

**Gate:** Eutaxy's own `eutaxy report` on its core shows `PROVEN` for the
enumerator and `CHECKED` or better for every invariant checker.
