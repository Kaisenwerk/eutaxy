# Example: a payments queue consumer

A Worker that consumes a `payments` queue and records each payment in D1.
Nothing in it looks wrong, and nothing in an ordinary test would fail.

## Run the check

From this directory:

```sh
pnpm install
pnpm check
```

The check runs the scenario in `payments.sim.ts` inside workerd, injecting
crashes, errors and lost replies at every effect the Worker performs and
redelivering messages the way Cloudflare Queues does. It reports:

```
VIOLATED  payments  (seed payments)

Invariant payment-recorded-once is violated: D1:DB run happened twice for key "o-2" ...

Schedule (run seed ...), events kept: msg-2
  ambiguous at msg-2#1 effect #0 (D1:DB run)
```

The insert committed but its answer was lost, so the handler threw, the
queue redelivered the message, and the order was recorded twice. (With
`--seed example` it reports the other way to get there: a crash between
the insert and `ack()`.) The trace
below the schedule shows every effect; a regression test,
`payments.regression.test.ts`, is written next to the scenario and fails
until the bug is fixed.

## The fix

`worker.fixed.ts` makes the insert idempotent (`ON CONFLICT (order_id) DO
NOTHING` over a unique `order_id`), so a redelivered message changes
nothing. `pnpm check:fixed` runs the same scenario against it and reports
`BOUNDED`: no violation within the stated bounds, which the report says
plainly is not a proof.

## Using it in your own project

Copy `payments.sim.ts` next to your Worker, replace the messages and the
invariants with yours, and point `worker` at your entry and wrangler config.
`eutaxy`, `vitest` and `@cloudflare/vitest-plugin` are the only
dependencies.
