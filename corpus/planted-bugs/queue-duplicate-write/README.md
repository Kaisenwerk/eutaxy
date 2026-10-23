# queue-duplicate-write

**The bug.** A queue consumer inserts a payment into D1 and then acknowledges
the message. Queues deliver at least once: if the invocation dies after the
insert commits but before `ack()`, the message comes back and the row is
inserted again. The table has no uniqueness on `order_id`, so nothing stops
the duplicate.

**Why it matters.** This is the most common shape of money bug on an
at-least-once queue, and it never shows up in a unit test because nothing in
a unit test crashes between two awaits.

**What Eutaxy must report.** `VIOLATED` on `payment-recorded-once`, with a
trace showing the insert, a `crash_before` fault on the ack, the redelivery,
and the second insert with `changes: 1`.

**The fix.** Make the write idempotent: a `UNIQUE (order_id)` constraint and
`INSERT ... ON CONFLICT (order_id) DO NOTHING`. The second insert then reports
`changes: 0`, which `d1Write` does not count, and both invariants hold.
