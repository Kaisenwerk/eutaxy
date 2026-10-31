# cron-dispatch-twice

**The bug.** Every five minutes the job reads the pending rows, posts each
to the dispatcher and marks it sent. Nothing ties the two steps together:
no idempotency key the dispatcher honours, no "dispatching" state written
first. If the invocation dies after a post left and before the row is
marked, the row is still pending when the tick is re-run (Cloudflare
documents `noRetry()` for scheduled handlers but no retry count, so the
scenario declares one re-run), and the re-run posts it again.

**Why it matters.** In an ordinary test the tick completes. The duplicate
needs the isolate to die in the gap between the post and the mark, and the
re-run that makes a reconciliation job robust against everything else.

**What Eutaxy must report.** `VIOLATED` on `dispatched-once`, with a trace
showing the post, then a failure before the row is marked (a crash after
the post, or the mark itself failing), the re-run of the tick with the same `scheduledTime`, and the second post for the same
dispatch id. The invariant `all-sent` holds: the re-run finishes the work.

**The fix.** Send an idempotency key the dispatcher honours (declare it with
`dedupeBy`), or mark the row `dispatching` before the post and skip rows in
that state on a re-run, reconciling them separately.
