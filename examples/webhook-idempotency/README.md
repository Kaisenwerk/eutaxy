# Example: a webhook with an idempotency key

A payment provider posts deposit events to a Worker, which credits an
account in a D1 ledger. The provider resends any event it got no 2xx for,
and every event carries an id that stays the same across resends, so the
Worker does what the provider's documentation asks: it keeps the ids of
the events it has processed and skips any it has seen. The check and the
two writes are each correct, and every ordinary test passes.

## Run the check

From `examples/webhook-idempotency` in the repository:

```sh
pnpm install
pnpm check
```

The check runs the scenario in `deposits.sim.ts` inside workerd: two
deposits, a provider that resends up to three times, and a fault (a crash,
an error or a lost answer) at every effect the Worker performs. It reports:

```
VIOLATED  deposits  (seed deposits)

Invariant credited-once is violated: 2 rows of ledger in D1:DB share event_id = "evt-1"

Schedule (run seed ...), events kept: req-1
  ambiguous at req-1#1 effect #1 (D1:DB run)
```

The credit committed but its answer was lost on the way back from D1, so
the handler threw before it recorded the event as processed and answered
500. The provider resent the event, the lookup found nothing, and the
account was credited twice. Any failure between the two writes does the
same; the trace under the schedule shows every effect of both attempts,
and `deposits.regression.test.ts`, written next to the scenario, replays
it until the bug is fixed.

## The fix

The lookup and the record of processed events are two statements, so
something can always come between them. `worker.fixed.ts` drops both and
makes the credit itself carry the key: `schema.fixed.sql` makes the
ledger's `event_id` unique and the insert says `ON CONFLICT (event_id) DO
NOTHING`, so a resend changes nothing and still gets its 200. `pnpm
check:fixed` runs the same scenario against it and reports `BOUNDED`: no
violation within the stated bounds, which the report says plainly is not
a proof.

## Using it in your own project

Copy `deposits.sim.ts` next to your Worker, replace the requests and the
invariants with yours, and point `worker` at your entry and wrangler
config. `unique` reads the table at the end of every run, so it counts
the rows of one table however many statements carry the same key;
`atMostOncePerKey` over `d1Write` counts committed writes instead, and
fits when the write you care about is the only one keyed by that value.
