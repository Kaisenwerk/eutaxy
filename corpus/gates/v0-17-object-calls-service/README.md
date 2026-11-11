# v0-17-object-calls-service

The first part of the v0.17 gate (`docs/roadmap.md`, "Inside the object"):
an object's calls through its own service bindings are the scenario's.
- **The object**: `quote` asks the model Worker inside the call it is
  serving and answers with what it said. `start` records a run, sets a
  watchdog alarm and answers; the job behind the answer asks the model for
  the plan, claims the run (`charging`) in the same synchronous block as
  its check, bills it through the billing Worker and records the charge.
  The watchdog settles only what is still `queued`.
- **The model**: both Workers are scripted with `service()`. Every call
  the object makes through `this.env` is an effect a fault can land on:
  `quote-1#1 call Service:MODEL estimate` inside the call, and
  `DO:JOBS/j/after call Service:BILLING charge` in the work after the
  answer. The call leaves the object once its earlier writes are durable,
  as behind the output gate.
- **The cells**: one and two invocations in flight, up to two faults,
  each `BOUNDED` with nothing unsupported; every schedule with one fault,
  exhaustively.
- **The replays**: where the object's calls are recorded; the same seed
  giving the same run, and two in flight interleaving the object's calls
  by the seed; an answer lost on the charge, a crash right after it (the
  claim written before the call is kept, so the watchdog bills nothing)
  and a call that never left; and the watchdog alarm failing on its last
  retry, which resets the object in the run's last event: it is woken
  inside the run, and the snapshot reads what it kept.

The invariants: no run is billed twice, and a run recorded as charged
carries its charge and the plan it was billed for.
