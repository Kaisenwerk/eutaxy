# Roadmap

Four phases, each closed by a gate that must pass before the next starts.
A gate is a test the corpora run in CI; a phase is done when its gate
passes, not on a date. The planted-bug and differential corpora start in
v0.1 and grow with every phase. The JSON report schema is versioned from
v0.1 so CI and coding agents can rely on it early.

## v0.0 — Scaffold (done 2026-10-22)

pnpm workspace with the eleven packages, declared dependencies mirrored by
project references and checked against the design, `pnpm check` green, a
`core` seeded PRNG and effect log with a test proving the same seed yields a
byte-identical log, per-package READMEs, and the public hygiene files:
README, LICENSE, CONTRIBUTING, CHANGELOG, code of conduct.

## v0.1 — Simulator (current)

- Scenario spec format (`*.sim.ts`): Worker, scenario, declared externals,
  invariants and bounds, designed with the first planted bug as its first
  user. (done)
- Bindings: D1 and Queues. (done)
- Faults: crash before, crash after, ambiguous outcome, error, redelivery
  cut-off of `waitUntil` work (all done).
- Scheduler: seeded exploration with a time-based budget. (done)
- Invariants: `atMostOncePerKey`, `atLeastOnce`, `implies`, `everyRow`
  (all done).
- Shrinker (done); text and versioned JSON report (done); Vitest regression
  emitter (done); `expectHolds` and `check` for use from a user's test
  suite (done); `eutaxy check` CLI with `--json` (done).
- Virtual clock and globals patching (done); module-state leak detection
  (done); published-package build and publish dry run (done).
- `examples/payments-queue`: the README quick start, runnable (done).
- Planted bugs so far: `queue-duplicate-write` (crash before ack),
  `queue-ack-then-write` (ack then write in `waitUntil`),
  `queue-random-id` (random row ids with `INSERT OR IGNORE`),
  `queue-charge-twice` (a charge without an idempotency key).
- First planted bug: a queue consumer writes to D1, crashes after the write
  and before ack, and redelivery duplicates the row. (done: runs in workerd
  and reaches `VIOLATED`)

**Gate:** every planted bug is caught, shrunk, replayed and emitted as a
regression test; the differential corpus shows no divergence from workerd;
the same seed produces a byte-identical trace twice. (Gate passed in CI on
2026-10-23. Polish landed the same day: module-state leak detection and
the published-package build with a publish dry run. v0.1 is complete apart
from the actual release.)

### v0.1.x

Outbound `fetch` with declared externals (`dedupeBy`, scripted replies) and
the `module_state_leak` detection pass. (done 2026-10-23)

### v0.1.y — AWS platform spike, pulled forward

The second-platform spike was planned for v0.4. It was brought forward on
2026-10-23 because the Cloudflare path is useful end to end and the engine
had just gained everything a second platform needs (platform-neutral
scenario data, scripted fetch, virtual globals, leak detection), so the
spike doubles as the test that the layering holds. Scope: Lambda with an
SQS event source and DynamoDB through the SDK `send` proxy, a planted bug
(`sqs-duplicate-put`), the differential runner. Not in scope yet: the
`eutaxy check` command for AWS scenarios, other services (S3, SNS,
EventBridge), SQS batches larger than one record.

### v0.1.z — Inbound HTTP drive, pulled forward

The maintainer's next Workers enter through `fetch` handlers (payment and
chat-platform webhooks with redelivery, a sign-in endpoint with rate
limits), and those are the first scenarios they want to write, before any
Durable Object is involved. An HTTP drive is small: a request is an event
like a queue message, delivered with the same faults, redelivered on the
caller's retry policy, and concurrent requests are the scheduler's
interleavings. Scope: `http` drive (method, path, headers, body, retries),
the `fetch` handler as the entry point, response recording, `waitUntil`
as today. Invariants stay the existing ones over D1 and `fetch` effects.

## v0.2 — Durable Objects and specs

- Durable Object storage (key-value and SQL, transactions), input and
  output gates, write coalescing, alarms; KV. First real target beside the
  wallet race: a lease pool that hands out at most one lease per slot and
  recovers a lease whose RPC response was lost; and an object that
  multiplexes several schedules over its one alarm (the pattern the
  Agents SDK uses), so alarm-driven state machines survive eviction.
- Exhaustive scheduler and partial-order reduction.
- Lemma spec parser, `SpecIR`, the `CHECKED` rung, `refines`.

**Gate:** the wallet race is caught; no false alarms on the Durable Object
corpus; the exhaustive enumerator's schedule count matches its closed-form
formula.

### v0.2.x

R2 and Workflows models.

## v0.3 — Provers

- `TESTED` rung; `Prover` interface, ladder and aggregation.
- First-party `prover-lean` engine on the initial subset (immutable data,
  algebraic types, structural recursion, bounded integers, quantifier-free
  arithmetic), with its contract corpus and translation validation; proof
  cache; `eutaxy prover install lean`.
- MCP server and GitHub Action over the JSON schema.

**Gate:** the first-party contract corpus passes against the pinned Lean
toolchain; the refund example reaches `PROVEN` with the first-party engine.

### v0.3.x

Optional Thales and LemmaScript adapters with their own contract corpora;
`CONFLICT` detection across engines.

## v0.4 — Self-check

Enumerator proven through a prover adapter; invariant checkers verified
against reference implementations; `eutaxy report`; a spike on a second
platform behind `Platform`.

**Gate:** Eutaxy's own `eutaxy report` on its core shows `PROVEN` for the
enumerator and `CHECKED` or better for every invariant checker.
