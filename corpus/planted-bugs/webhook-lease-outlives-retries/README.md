# webhook-lease-outlives-retries

**The bug.** The webhook takes a per-subscription lease in D1 before it
applies an event, answers 503 while another handler holds it, and relies
on the caller to resend later. The lease lives 24 hours. The caller
resends four times over about six hours (after 15 s, 5 min, 1 h and 6 h).
Any failure between taking the lease and releasing it (an error on the
next statement, a crash) leaves it held, every resend gets 503, and the
caller gives up: the event is never applied.

**Why it matters.** The lease and the 503 are correct; the bug is the
ratio between two durations, the lease's lifetime and the caller's resend
schedule. A test whose resends come at once cannot see it, and cannot
see the fix either: with no delay between resends even a one-minute lease
is still held at every resend.

**What Eutaxy must report.** `VIOLATED` on `every-event-applied`, with a
trace showing the lease taken, the failure, and four resends answered 503
at the caller's delays. With a 60-second lease the scenario is `BOUNDED`,
and the same 60-second lease is `VIOLATED` again if the resends come
without delays.

**The fix.** Keep the lease shorter than the first resend that should
take it over, or release it in a `finally` and give it a lifetime bound
by the handler's own time limit.
