# object-charge-twice-after-answer

**The bug.** An object runs jobs it does not wait for and bills each one:
`start` records the run, sets a watchdog alarm and answers at once; the job
behind the answer charges the customer through the billing Worker, a
service binding the object calls through its own `env`, and then records
the run as charged. The watchdog settles whatever is still queued when it
fires, so a job lost with the object's memory is picked up again. The
charge leaves before anything records that it is being made: when billing
charged and the object did not get to record it (the object was reset
right after the call, or the call's answer was lost), the run is still
queued, and the watchdog charges it a second time.

**Why it matters.** The call is made by the object, not by the Worker, in
work that runs after the caller already has its answer: no request fails,
no test waits for it, and the second charge comes thirty seconds later
from an alarm. It is only reachable when the object's own call through its
binding is something a fault can land on, which is what the model makes it:
an effect of the object's own invocation, `DO:RUNNER/r/after`.

**What Eutaxy must report.** `VIOLATED` on `charged-once`, with one fault
on `Service:BILLING charge` in the object's work after its answer, and the
second charge made by the alarm. Seeded and exhaustive exploration both
find it. `FixedRunner` is `BOUNDED`, seeded and exhaustively.

**The fix.** Claim the run before the charge leaves: record it as
`charging` in the same synchronous block as the check, and let the
watchdog settle only what is still `queued`. The claim is durable before
the call leaves the object, as the output gate guarantees, so a reset
after the charge finds it. A run the object did not get to finish stays
`charging`, to be reconciled with billing; none is charged twice.
