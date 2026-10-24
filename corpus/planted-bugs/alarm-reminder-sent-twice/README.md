# alarm-reminder-sent-twice

**The bug.** A Durable Object keeps reminders and sends each one from its
alarm through a mail API, then marks it sent. The send carries no
idempotency key. Cloudflare runs an alarm handler at least once and
retries it when it fails, so a failure after the mail went out and before
the reminder was marked sent (the handler dying, or the API's answer
being lost) makes the retry send the same reminder again.

**Why it matters.** The alarm fires once in every ordinary test, and a
test that waits for real alarms cannot place a crash between two lines of
the handler. Here the alarm fires in virtual time, a minute after the
reminder is added, and the crash lands inside it.

**What Eutaxy must report.** `VIOLATED` on `reminder-sent-once`, with the
alarm firing, a fault on the send, the alarm's retry after two seconds,
and a second effective send for `rem-1`. The fixed object
(`FixedReminders`), which sends the reminder's id as its idempotency key,
is `BOUNDED`: the retry's send is deduplicated.

**The fix.** Send with an idempotency key derived from the reminder, or
mark the reminder as being sent before sending and reconcile on retry.
