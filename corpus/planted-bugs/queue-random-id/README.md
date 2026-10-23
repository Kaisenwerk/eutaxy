# queue-random-id

**The bug.** Each payment row gets `crypto.randomUUID()` as its primary key
and the insert uses `OR IGNORE`, which the author took to mean "safe to
retry". It only ignores collisions on `id`, and random ids never collide, so
a redelivery after a crash before `ack()` records the order a second time.

**Why it matters.** Random ids and `OR IGNORE` are a common pair, and the
duplicate only appears under redelivery.

**What Eutaxy must report.** `VIOLATED` on `payment-recorded-once`, keyed on
the order id (the second bound parameter), with a trace in which the two
inserts carry different UUIDs and virtual timestamps. Those values come
from the run's seed, so the trace is byte-identical on replay; without the
globals patch the verdict would be `UNSUPPORTED: not_replayable`.

**The fix.** Make `order_id` unique and insert with `ON CONFLICT (order_id)
DO NOTHING`, or derive the id from the order.
