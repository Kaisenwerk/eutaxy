# queue-ack-then-write

**The bug.** The consumer acknowledges each message immediately and does the
D1 write in `ctx.waitUntil`. Acknowledged messages are never redelivered, and
background work is best effort: if the isolate is cut off after the
acknowledgement, the write never happens and nothing will retry it.

**Why it matters.** "Ack early, write in waitUntil" looks like a throughput
optimisation and passes every ordinary test, because nothing in a test cuts
an isolate off between two awaits.

**What Eutaxy must report.** `VIOLATED` on `every-payment-recorded`, with a
trace showing the explicit ack, then a crash before the insert: either a
`cut_off` at the background point or a crash inside the background work.
The corpus test also replays an explicit `cut_off` schedule and checks the
in-flight lookup completes while the insert never starts.

**The fix.** Do the write before acknowledging, or let the handler return
without an explicit ack so a crash before the write redelivers the message.
