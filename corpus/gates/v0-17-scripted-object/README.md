# v0-17-scripted-object

The gate entry for a scripted Durable Object (`docs/roadmap.md`, "Patch
work"): a namespace whose objects answer from the scenario, for a class
the test's isolate cannot run.
- **The objects**: a pool runs each job on a machine of its own, an
  object of a second namespace backed by a container. The pool claims a
  job before it boots the machine, warms the machine over HTTP in work
  after its answer, with a watchdog alarm for whatever stayed cold, and
  stops a job by asking for a snapshot (which this deployment does not
  have) and halting the machine either way. The Worker also asks a
  machine for its status itself.
- **The model**: the machines' namespace has a `scriptedObject()` step.
  Each call on a machine is one effect on `DO:MACHINE`, with the
  machine's name in its arguments and a stub call's faults, answered from
  the script: inside the Worker's call into the pool (`start-a#1 call
  DO:MACHINE boot`), in the pool's work after its answer
  (`DO:POOL/pool/after call DO:MACHINE fetch`), from its alarm, and from
  the Worker. No machine is constructed: the class counts its
  constructions, and the count stays at zero.
- **The cells**: one and two invocations in flight, up to two faults,
  each `BOUNDED` with nothing unsupported; every schedule with one fault at
  one in flight, and every order of two in flight without a fault,
  exhaustively.
- **The replays**: where the calls are recorded, a scripted error
  reaching the pool as the error it is, and a fetch recorded with its
  request; the same seed giving the same run; and each fault on the boot:
  the call never leaving and the pool reset with a claim it had not made
  durable, the call failing, the answer lost, and the pool dying with
  the machine booted, where the claim (durable before the call left) is
  found and the resend boots the machine that runs. A failed warm-up is
  the watchdog's, and the Worker's own failed call is the Worker's to
  resend.

The invariants: a machine that was booted, or halted, is a job the pool
has on record; a job recorded as running carries its machine's address;
and only a job that got its machine is marked warm.
