# workflow-late-attempt-fenced-turn

**The bug.** A Workflow starts a chat turn on the object that owns the
conversation, in a step with a two-minute `timeout`, and when the step
fails for good it calls `abandonTurn`, which fences the turn id so that a
start still in flight is refused. The object checks the fence before it
asks the model for the run's plan and writes the run when the answer comes
back, without checking again. Workflows gives up on an attempt that
outlives its timeout but cannot stop it, so the start goes on while the
Workflow abandons the turn: the fence is set while the start waits for the
model, and the start then writes the run of an abandoned turn.

**Why it matters.** Locally a step attempt never outlives its timeout
unless the test waits two minutes, and the fence looks sound: it is checked
before anything else happens. The race only exists because the engine's
timeout and the attempt's call run on independently, which is exactly what
the model does with a timed-out attempt: it runs on as the late attempt,
and its call may land before, between or after the recovery's.

**What Eutaxy must report.** `VIOLATED` on `fenced-turns-never-run`: the
row for `t-1` is fenced and has a run. Seeded and exhaustive exploration
both find it. `FixedConversation`, which checks the fence again in the same
synchronous block as its write, is `BOUNDED`, seeded and exhaustively.

**The fix.** Check the fence again after every `await` and before the
write, with no `await` between the check and the write: the object's input
gate then lets no other call in between them.
