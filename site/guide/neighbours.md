---
title: Eutaxy and its neighbours
description: What Eutaxy adds to a Vitest run under Miniflare, and how it relates to property-based testing, model checkers and deterministic simulation testing.
---

# Eutaxy and its neighbours

Eutaxy sits between tools you may already use. It reuses some of them and
borrows its method from others. This page says what each one gives you,
what Eutaxy adds, and where Eutaxy stops.

## A Vitest run under Miniflare

The [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
runs your Worker in workerd, with local D1, R2, Durable Objects, Queues
and Workflows. A test drives it once, along one path: every call
succeeds or fails as written, every message is delivered once, and two
requests interleave only if the test arranges it.

Eutaxy runs inside that same setup (`eutaxy check` writes a test for it,
and your own Vitest config can call `check()`), with your Worker's real
code against the same local bindings. What it adds is the exploration:
- **Faults at every effect.** Each binding call is a point where the run
  can crash before or after the call, or lose the answer after the far
  side acted. The platform then redelivers or retries the way Cloudflare
  does: Queues at least once, an HTTP caller resending, an alarm retried,
  a Workflow step run again.
- **Interleavings.** With `maxConcurrentInvocations` above 1, invocations
  interleave at their I/O, including inside a Durable Object while it
  awaits an outbound `fetch`.
- **Virtual time.** Timers, alarms, Workflow sleeps and Cron ticks fire in
  virtual time, so a 24-hour timeout costs nothing.
- **Invariants and a minimal schedule.** You state what must hold after
  every run. A violation comes back shrunk to the fewest events and
  faults, with its trace, and as a regression test.

What it does not replace: tests of what your Worker returns for a given
request. Keep those; Eutaxy checks what must stay true when the platform
misbehaves.

## Property-based testing

[fast-check](https://fast-check.dev) and its relatives generate inputs
for a function, check a property on each, and shrink a failing input.
Eutaxy does this for the pure core: a spec file's `forall` properties run
on inputs drawn from the parameters' types (the `TESTED` rung), and a
refutation is shrunk and replayed.

The simulation applies the same idea to a different space. The inputs are
schedules: which events arrive, in what order, and which effects fail.
Those come from the platform model, not from your types, and the same
seed gives the same run every time.

## Model checkers

[TLA+](https://lamport.azurewebsites.net/tla/tla.html), P and Alloy
explore every state of a model you write next to the code. They can show
that a design holds for every behaviour within the model's limits. The
model is a second description of the system, and it can drift from the
code.

Eutaxy explores the code itself, so it cannot drift. The price is
completeness. A simulation verdict is `BOUNDED`: no violation within the
stated bounds (faults per run, redeliveries, concurrency, time), and the
report says plainly that this is not a proof. `--exhaustive` runs every
schedule within the bounds once. Where a proof is possible, on the pure
core, the prover rung gives one: the Lean and Z3 engines translate the
TypeScript and return `PROVEN`, `REFUTED` or `UNKNOWN`. A further step,
proving the shell against the platform model, is on the
[roadmap](/reference/roadmap).

## Deterministic simulation testing

Deterministic simulation testing is the method Eutaxy applies: run the
real code under a controlled scheduler and fault injector, so any failure
replays from its seed. FoundationDB made it well known, and TigerBeetle
and Antithesis are later examples. Those simulate a whole system, its
network, disks and clock.

Eutaxy is narrower on purpose. It controls only the boundary between your
Worker and Cloudflare: the bindings, timers, `fetch`, and the platform's
delivery rules, each modelled from Cloudflare's documentation and checked
against the local runtime. That narrowness is why it needs no special
runtime and no rewrite: the Worker runs as written. It is also why a run
that reaches past that boundary (a binding it does not model, a socket,
real I/O it cannot see) ends [`UNSUPPORTED`](/reference/unsupported)
rather than guessing.

## When to use which

| You want to know                                                         | Use                                         |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| what the Worker returns for a request                                     | a Vitest test                               |
| that a pure function holds a property for all inputs of its types        | a spec file: `TESTED`, then `PROVEN`        |
| that retries, crashes, lost answers and interleavings break no invariant | an Eutaxy scenario                          |
| that a protocol design is correct before any code exists                 | a model checker                             |
