# rpc-reserve-twice

**The bug.** The inventory service is a `WorkerEntrypoint` other Workers
call over RPC. Its `reserve(orderId, qty)` inserts the reservation into D1
and returns it. Nothing makes the insert idempotent: no unique constraint
on the order id, no lookup first. Cloudflare does not retry an RPC call, but
the calling Worker does when the call throws or gets no answer, so a crash
after the insert and before the answer makes the resend reserve the same
order twice.

**Why it matters.** Every call in an ordinary test gets its answer. The
duplicate needs the isolate to die between the write committing and the
return value leaving, and a caller written to retry.

**What Eutaxy must report.** `VIOLATED` on `reserved-once`, with a trace
showing the insert, a crash before the response (or right after the write),
the resend, and the second insert for the same order id. The invariants
`every-order-reserved` and `one-answer` hold: the resend recovers the
order, and the caller stops once it has an answer.

**The fix.** Make the order id unique (`INSERT ... ON CONFLICT DO NOTHING`
or a unique index) so a resend is a no-op that still answers.
