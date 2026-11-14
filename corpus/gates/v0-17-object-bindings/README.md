# v0-17-object-bindings

The part of the v0.17 gate (`docs/roadmap.md`, "Inside the object") for an
object's remaining bindings: a Workflow binding on an object's own `env`
is the model's, as the Worker's is, and a call on a binding the
simulation does not model is refused from inside an object as it is from
the Worker.
- **The object**: `submit` records the job as accepted, creates a
  Workflow instance whose id is made from the job's, and records the job
  as started; the instance's step calls back into the object to mark the
  job done. A job submitted twice starts one run: the engine refuses a
  second instance of the same id, and the object takes that as started.
  `progress` finds the instance through the binding and asks how it
  stands.
- **The model**: each call the object makes on the binding, and on the
  instance it gives, is an effect a fault can land on
  (`job-1#1 call Workflow:RUNS create` inside the call it is serving),
  leaving the object once its earlier writes are durable, as behind the
  output gate; the instance runs the scenario's class as an event of the
  run (`workflow:RUNS:run-a#1`), never in the local engine.
- **The cells**: one and two invocations in flight, up to two faults,
  each `BOUNDED` with nothing unsupported; every schedule with one fault at
  one in flight, exhaustively; and two in flight without a fault, 150
  seeded runs.
- **The replays**: where the object's calls are recorded; the same seed
  giving the same run, and two in flight interleaving them by the seed;
  the instance created and its answer lost (the resend's create is
  refused, the job has one run); the object reset right after the
  instance was created (the job it had accepted is kept, the resend
  records the run); and the create never reaching the engine (the resend
  creates the instance).
- **The refusal**: the object's read of a KV namespace through its own
  `env` ends the check `UNSUPPORTED` with `binding CACHE is not proxied`.

The invariants: a job recorded as started or done has its run, a run that
finished has finished its job, and no job has two runs.
