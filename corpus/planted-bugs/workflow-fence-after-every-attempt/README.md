# workflow-fence-after-every-attempt

**The bug.** A Workflow starts a chat turn on the object that owns the
conversation, in a step with a two-minute `timeout` and two retries, after
loading the turn's context and checking the caller's quota, and announces
the run afterwards. When all three attempts have failed it calls
`abandonTurn`, which fences the turn id so that a start still in flight is
refused. The object checks the fence before it asks the model for the
run's plan and writes the run when the answer comes back, without checking
again. An attempt that outlives its timeout runs on, so the last attempt's
start can write the run of a turn the Workflow abandoned while it waited.

**Why it matters.** It is the late-attempt race of
`workflow-late-attempt-fenced-turn` behind retries, which is how such a
step is usually configured. Reaching it takes a fault on each of the three
attempts of one step, the last of them a timeout, among the 19 or so
points of a run that may take a fault. Sampling with up to three faults a
run spends its faults everywhere and stays `BOUNDED` over 200 runs on this
entry's seed. The scenario says where faults go instead: with
`faultsAt: [stepFaults("TURNS", "start turn")]` in its bounds, a run puts
faults only on that step's attempts, and exhaustive exploration finds the
violation within a dozen schedules.

**What Eutaxy must report.** `VIOLATED` on `fenced-turns-never-run` for the
default scenario (faults on the step's attempts), exhaustively; `BOUNDED`
for `anywhere` (the same scenario with faults anywhere) under 200 sampled
runs. `FixedConversation`, which checks the fence again in the same
synchronous block as its write, is `BOUNDED` under 300 sampled runs with
faults on the step's attempts. Its full space of schedules at two
invocations in flight is past what a test can run (6,000 schedules in five
minutes did not finish, the partial-order reduction being off since both
chains call one object).

**The fix.** Check the fence again after every `await` and before the
write, with no `await` between the check and the write: the object's input
gate then lets no other call in between them.
