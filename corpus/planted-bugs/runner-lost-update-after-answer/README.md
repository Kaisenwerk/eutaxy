# runner-lost-update-after-answer

**The bug.** An object runs jobs after answering, the way an agent does:
`start` records the run, kicks the job off with `void` and answers at once;
the job reads a running total, asks an external model for the plan, and
writes the total plus its steps. Nothing awaits the job, and a Durable
Object's input gate holds other events only while it waits on its own
storage, not while it awaits an outbound `fetch`, so a second job started
on the same object reads the total while the first awaits the model: both
read 0, both write 2, and the total ends at 2 where 4 steps ran.

**Why it matters.** The race is in work no answer waited for: each caller
got its `{ accepted: true }` long before. Eutaxy runs that work as the
object's own invocation after the answers, `DO:RUNNER/r/after`, whose model
calls are turns of their own, so a concurrent run interleaves the two jobs
and the lost update shows in a table the object's own storage holds.

**What Eutaxy must report.** `VIOLATED` on `each-job-reaches-a-new-total`
with no fault: both runs record the total 2. The fixed object (`FixedRunner`), which adds
the steps in one statement after the model answered, is `BOUNDED` with two
in flight.

**The fix.** Add the steps to the total in one statement instead of writing
a value read before the outbound call.
