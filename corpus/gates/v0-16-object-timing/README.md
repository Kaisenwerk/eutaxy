# v0-16-object-timing

The v0.16 object (`docs/roadmap.md`, "Work that goes on after the answer")
in three timings of the same job, each a way real objects arrange their work
around an answer, with the faults that fall around it. The object adds the
job's steps to the running total in one statement and records the total it
brought the object to.
- **`slow`** waits on a timer of its own before it answers. The model lets
  the timer fire while the call is in flight: the call completes, in a
  sequential run and with two such calls inside the object at once, and the
  model call is the call's.
- **`eager`** asks the model before answering and does not wait for the
  reply. Opened during the call, the model call is the call's; parked when
  the answer crosses (two calls in flight), it is the object's own turn,
  `DO:RUNNER/r/after`. Once the call has answered, the work is the object's:
  the caller's crash does not end it, and a fault in it resets the object,
  not the caller. A crash during the call crashes the call and resets the
  object, and the run goes on to the next event.
- **`hashed`** answers, then does real work that is not an effect (a digest)
  before it asks the model. The run waits for that work: the model call after
  it is the object's own.

Every scenario must be `BOUNDED` with nothing unsupported, at one call and
at two calls in flight; the other tests replay the traces and the fault
placements. The companion `v0-16-object-work-after-answer` holds the gate's
object whose work starts a tick after the answer.
