# v0-16-object-work-after-answer

The first half of the v0.16 gate (`docs/roadmap.md`, "Work that goes on
after the answer"): an object that answers a call and goes on with work it
did not await, the way an agent runs a job after accepting it.
- **The object**: `start` records the run, kicks the job off with `void`, and
  answers at once. The job waits a tick, asks an external model for the plan,
  and writes the result into the object's own tables, adding its steps to the
  total in one statement.
- **The model**: the work runs as the object's own invocation,
  `DO:RUNNER/r/after`, after both answers, as turns of its own; a sequential
  run lets it run to rest before the next event, a concurrent run interleaves
  it with the second call. A crash injected into it resets the object: the
  answers the callers got stand, the work is lost with the instance.

The scenario must be `BOUNDED` with nothing unsupported; the second test
shows the trace and holds replay to the same run; the third injects the
crash. The planted bug `runner-lost-update-after-answer` is the same object
with the total read before the model call and written after it.
