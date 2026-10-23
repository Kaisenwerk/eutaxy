# webhook-duplicate-record

**The bug.** The webhook handler inserts the provider's event into D1 and
answers 200. Nothing makes the insert idempotent: no unique constraint on
the event id, no lookup first. A payment provider resends any webhook it
did not get a 2xx for, so a crash after the insert and before the response
makes the resend record the same event twice.

**Why it matters.** Every delivery in an ordinary test gets its response.
The duplicate needs the isolate to die in the few microseconds between the
write committing and the response leaving, and a caller that retries.

**What Eutaxy must report.** `VIOLATED` on `event-recorded-once`, with a
trace showing the insert, a crash before the response (or right after the
write), the resend, and the second insert for the same event id. The
invariants `every-event-recorded` and `one-ok-response` hold: the resend
recovers the event, and the caller stops once it has a 2xx.

**The fix.** Make the event id unique (`INSERT ... ON CONFLICT DO NOTHING`
or a unique index) so a resend is a no-op that still answers 200.
