# workflow-approval-notify-twice

**The bug.** The approval Workflow waits for the decision event, then calls
the notification service directly, not inside a `step.do`. Workflows replay
`run()` from the start after a restart; the wait's event is persisted, so
the replay gets the stored decision at once and runs the notification code
again.

**Why it matters.** In an ordinary test the instance completes once. The
duplicate needs the engine to restart between the notification leaving and
the run finishing, which a crash right after the call produces, and which
nothing in the code guards against.

**What Eutaxy must report.** `VIOLATED` on `notified-once`, with a trace
showing the wait receiving the event, the notification, a crash after it,
the restart replaying the stored event, and the second notification for
the same document. `one-run-per-document` holds.

**The fix.** Make the notification a step (`FixedApprovalFlow`): persisted
once it ran, a replay returns its result instead of running it again. And
give it an idempotency key the service deduplicates by, since a step whose
answer was lost is retried, and the retry posts again.
