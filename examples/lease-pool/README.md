# Example: a lease pool object with an alarm

A pool of build runners shared by many projects lives in one SQLite-backed
Durable Object. `acquire` leases the first free runner for five minutes
and records the grant for billing; the object's alarm wakes at the next
expiry, takes expired leases back and closes their grants. The Worker in
front of it asks for a lease and retries a call to the object that
failed, with the same token, since a call can fail before it ever reaches
the object.

## Run the check

From `examples/lease-pool` in the repository:

```sh
pnpm install
pnpm check
```

The scenario in `leases.sim.ts` seeds the object's tables with three free
runners, sends two lease requests, and lets the alarm fire in virtual
time, so the five-minute expiry takes no time to reach. Every call to the
object can fail before it arrives, fail after it committed with the answer
lost, or crash the caller after it. The check reports:

```
VIOLATED  leases  (seed leases)

Invariant one-runner-per-request is violated: 2 rows of pool/grants in DO:POOL share token = "..."

Schedule (run seed ...), events kept: req-1, req-2
  ambiguous at req-2#1 effect #0 (DO:POOL acquire)
```

The object granted the lease and committed it, but its answer was lost.
The Worker's retry is right for a call that never arrived and wrong for
this one: `acquire` took the next free runner, and one request now holds
two. Ordinary tests never see it, because a call to a Durable Object
either succeeds or fails before it starts in every one of them. The
trace shows the alarm firing three times afterwards and closing every
grant, which the second invariant, `every-lease-ends`, checks.

## The fix

`worker.fixed.ts` looks up the project's lease before taking a free
runner: a call with the same token is a retry and gets its lease back, and
a call with another token waits its turn. `pnpm check:fixed` reports
`BOUNDED` over the same scenario, faults on the alarm included.

## Using it in your own project

`durableObject` clears the namespace before each run; its `sql` option
creates a SQLite-backed object's tables and rows, and
`durableObjectTable` reads one table at the end of the run for state
invariants. An alarm fires in virtual time at the time the object set,
and a failed alarm is retried on Cloudflare's schedule.
