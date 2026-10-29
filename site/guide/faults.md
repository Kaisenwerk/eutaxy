---
description: The faults Eutaxy injects at every effect boundary of a Cloudflare Worker, how seeded and exhaustive exploration choose schedules, partial-order reduction, the virtual clock, shrinking and replay.
---

# Faults and exploration

## Schedule points are effect boundaries

Eutaxy controls exactly the points it intercepts: proxied binding calls,
outbound `fetch`, and patched timers. Each such call is an **effect
point**. Every other `await` resolves in program order. That is what
"bounded" and "exhaustive" range over, and it needs no transform of your
code. Races between two awaits that touch no effect are a documented limit;
when their stale reads reach an effect, [`refines`](/guide/invariants#refines)
catches them.

## The fault model

At every effect point, a run may inject one of these faults:

| Fault               | What happens                                                                                                              | Why it matters                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Crash before effect | The effect never happens; the invocation dies                                                                             | Lost work, missing writes      |
| Crash after effect  | The effect happened; the invocation dies before continuing                                                                | Duplicate effects on retry     |
| Ambiguous outcome   | The effect committed, but the caller sees a timeout or error                                                              | Breaks most retry logic        |
| Error               | The effect fails cleanly with an error                                                                                    | Error-handling paths           |
| Redelivery          | A queue message or alarm is delivered again; an inbound request is resent by its caller                                   | At-least-once semantics        |
| Cut-off             | The response was sent; `waitUntil` work not yet started is lost, and an effect in flight commits without its continuation | Background work that never ran |

What each fault means at a given binding follows that binding's documented
semantics; a Durable Object call that fails with `crash_before` never
reached the object, while `ambiguous` means the object committed and the
answer was lost. See [Cloudflare Workers](/platforms/cloudflare).

## Seeded exploration

By default, `eutaxy check` explores runs drawn from a seed (the scenario's
file name unless `--seed` is given):
1. The first run injects no fault. It checks the scenario as written and
   counts the effect points that may take one.
2. Every later run draws from the seed how many faults to inject (one up
   to `maxFaultsPerRun`), at which points, and of which kind. Faults are
   placed by position, uniformly, so a fault is as likely on a Workflow's
   last step as on its first effect.
3. Some runs inject nothing, so a path that depends on randomness or on
   the order of turns is measured more than once.

Exploration stops at the first violation, or when the time budget
(`budgetMs`, or `--budget-ms`) or the run cap (`--max-runs`) is reached.

## Exhaustive exploration

`--exhaustive` runs every schedule within the bounds exactly once, instead
of sampling. A run's nondeterminism is a sequence of choices (a fault or
none at each eligible effect point, the next invocation at each scheduling
decision); runs are deterministic, so the enumerator walks the tree of
choices depth first, re-running from the reset with an ever longer forced
prefix. A run that makes different choices after the same prefix makes the
verdict `UNSUPPORTED` (`not_replayable`).

**Partial-order reduction** is on by default. Two turns of different
invocations whose effects have different targets commute, so once one
order has run the other is skipped (sleep sets). A turn that does more than
its effect (another effect, queuing an event, reading the clock or
randomness, setting a timer) turns the reduction off for that scenario,
and the enumeration starts again over every order. Every exhaustive
verdict reports whether the enumeration completed, how many schedules ran,
and whether the reduction stayed on.

The enumerator itself is checked against closed-form counts of schedules,
and its model is proven in Lean in Eutaxy's own repository.

## Concurrency

With `maxConcurrentInvocations` above 1, invocations interleave at their
I/O, as concurrent requests do in one isolate. Each asynchronous effect is a
turn: the invocation parks there, and once every invocation in flight has
parked, finished or gone idle, one of them performs its effect and runs to
the next. The pick comes from a stream seeded by the run's seed, separate
from the fault decisions, so a replay makes the same picks. An invocation
waiting on nothing Eutaxy can see makes the run `UNSUPPORTED`.

## Virtual clock and randomness

For the duration of a run, `Date`, `Math.random`, `crypto.randomUUID`,
`crypto.getRandomValues`, `performance.now` and the timer functions are
replaced with deterministic versions derived from the run's seed. Time
starts at 2026-01-01T00:00:00Z, advances one millisecond per completed
effect, and jumps to each timer's due time when it fires. Timers fire only
while nothing else can move, in due order, so they never race real I/O.
Web Crypto (`crypto.subtle`) is real work the engine waits for, never
faulted. Everything is restored after the run, including on failure.

Code that captured `Date.now` or `Math.random` at module load escapes the
patch, and module-level state cannot be reset between runs. Before
reporting `BOUNDED`, Eutaxy replays the first runs in reverse order and
compares their logs with the originals; any difference makes the verdict
`UNSUPPORTED` with cause `module_state_leak`.

## Shrinking and replay

Every violation is replayed before it is reported, so a run that does not
reproduce is never shown as a bug. The shrinker then tries, smallest change
first, removing one fault and then one input event, and keeps a candidate
only when replay still violates the same invariant for the same keys. The
verdict reports the kept events, the shrunk schedule and the replayed trace.

A schedule keys each fault by invocation and by the effect's position
within that invocation (`ambiguous at msg-2#1 effect #0`), not by a global
index, so it stays valid when other invocations are removed. That is what
the regression test replays.
