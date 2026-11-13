# v0-17-nested-object-timing

The object of `v0-16-object-timing` in the same three timings (`slow`,
`eager`, `hashed`), called by another object and not by the Worker: the
Worker calls `Front`, which notes the run in its own storage, passes the
call on to `Runner` through its own `env`, and notes the answer. A call
nested in another object's call meets everything a call from the Worker
does, so each timing is checked nested as it is checked from the Worker:
- **`slow`**: the runner sleeps on a timer of its own before it answers,
  while the front object's call, which awaits it, is in flight too. The
  timer fires, in a sequential run and with two requests in flight, and
  the model call is the request's.
- **`eager`**: the runner asks the model before answering and does not
  wait. Parked when its answer crosses, the model call is the runner's own
  turn, `DO:RUNNER/r/after`; a crash in it resets the runner alone, after
  both requests were answered through the front object.
- **`hashed`**: the runner answers, then does real work that is not an
  effect before it asks the model; the run waits for it.

A crash inside the runner during the call ends the request and resets both
objects. Every scenario must be `BOUNDED` with nothing unsupported, without
a fault and under every placement of one, at one invocation and at two in
flight. The engine's own `nested-calls.test.ts` runs many more timings and
nestings against a fake runtime; this entry holds the ones above against
the real one, where an object's code has no async context of its caller's.
