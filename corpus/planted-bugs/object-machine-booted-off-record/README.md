# object-machine-booted-off-record

**The bug.** A pool object runs each job on a machine of its own: an
object of a second namespace, backed by a container. The pool's table of
jobs is the only record of which machines run. `start` boots the machine
and records the job once the machine has answered. When the machine
booted and the pool did not get to record it (the pool was reset right
after the call, or the call's answer was lost), a machine runs that no
record names: nothing stops it, and nothing sweeps it.

**Why it matters.** The machine cannot run in the test's isolate, which
has no container, so a test of the pool either leaves the call out or
stands a class in for the machine, and neither puts a fault on the call
itself. Scripted with `scriptedObject()`, the call is an effect of the
pool's invocation, `DO:MACHINE boot`, with a stub call's faults, and the
bug is one fault away.

**What Eutaxy must report.** `VIOLATED` on
`a-booted-machine-is-on-record`, with one fault on `DO:MACHINE boot`
inside the Worker's call into the pool. Seeded and exhaustive exploration
both find it. `FixedPool` is `BOUNDED`, seeded and exhaustively.

**The fix.** Claim the job before the boot leaves: record it as
`booting`, then boot, then mark it `running`. The claim is durable before
the call leaves the object, as the output gate guarantees, so a reset
after the boot finds it. A job left `booting` names a machine that may
run, for a sweep to halt or a resend to adopt; no machine runs off the
record.
