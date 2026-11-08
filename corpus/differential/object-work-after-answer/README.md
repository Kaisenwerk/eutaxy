# object-work-after-answer

An object answers a call and goes on with work it did not await: the job
asks an external model for the plan and writes the result into the object's
own tables. Under Eutaxy that work is the object's own invocation after the
answer; in the raw run the object finishes it natively, as Miniflare keeps
the object alive while anything of its is pending. The two must agree on
every answer and on the object's tables.

The job starts at once, with no timer: nothing drives the object's virtual
timers in the raw run, so a job that waited on one would never finish there.
Timers in such work are the model's own (`docs/design.md`, Durable Objects).
