# v0-16-step-timeout

The v0.16 Workflow step attempt that outlives its timeout
(`docs/roadmap.md`, "Work that goes on after the answer"). A Workflow starts
a turn on an object in a step with a `timeout` and one retry and, when the
step fails for good, abandons the turn. The object fences an abandoned turn:
a start still in flight when the fence is set is refused, because the fence
is checked again in the same synchronous block as the write.
- **The fault.** `ambiguous` at the step point is an attempt that outlives
  its timeout from its start: the step is retried after its delay while the
  attempt runs on as the late attempt. Both starts reach the object; the
  retry's answer is the step's, the late one's is noted (`late_result`) and
  dropped. In a concurrent run the late attempt's call lands before or after
  the retry's, by the seed, and each order replays. When the retry fails
  too (an `error` on its call), the recovery fences the turn and the late
  start finds the fence: no run.
- **Measured.** A start that naps three minutes inside the object before
  answering outlives the two-minute timeout: the step's deadline fires while
  the object naps (`step_timeout`), the retry naps and times out too, the
  recovery fences the turn, and both late starts are refused when they wake.

After the step, the flow sleeps ten minutes and confirms the turn's row on
the object, as a real flow reads back what it did.

Every cell must be `BOUNDED` with nothing unsupported: naps of 0 and 3
minutes, one and two invocations in flight, up to two faults a run (which
runs schedules with one fault too), and every schedule with one fault at
one in flight, exhaustively.
A late start's turns hold nothing, so its fetch inside the object can land
after the confirming read and take a crash fault there: the object is then
reset by the run's last event, and woken inside the run for the snapshot.
There is no differential entry: the Workflows engine is modelled, not run
(`docs/design.md`, Workflows), so the local runtime has nothing to compare
against. The planted bug for this feature is
`corpus/planted-bugs/workflow-late-attempt-fenced-turn`.
