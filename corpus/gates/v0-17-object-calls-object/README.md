# v0-17-object-calls-object

The part of the v0.17 gate (`docs/roadmap.md`, "Inside the object") for
calls between objects: a call one object makes into another through its
own `env` is the scenario's.
- **The objects**: a cart takes a unit of an item from the item's shelf
  and keeps the item once the shelf has answered. The shelf holds one
  unit and keys a take by the cart. Before it gives a unit it asks the
  cart, which is waiting on it, how many it may hold. After its answer it
  tells an auditor what it gave, and the auditor calls back into the
  shelf to say it has it; a watchdog alarm tells the auditor again
  whatever stayed unaudited. A cart asked for its size asks itself,
  through its own namespace, and hands the answer on.
- **The model**: each of those calls is an effect of the invocation the
  calling object's code runs as, hosting what the called object does
  (`add-1#1 call DO:SHELF take`, and inside it `add-1#1 call DO:CART
  limit`; after the shelf's answer, `DO:SHELF/widget/after call DO:AUDIT
  note`), leaving the calling object once its earlier writes are
  durable. A crash inside a called object ends the invocation and resets
  every object the call went through.
- **The cells**: one and two invocations in flight, up to two faults,
  each `BOUNDED` with nothing unsupported; every schedule with one fault,
  exhaustively.
- **The replays**: where the calls are recorded; the same seed giving
  the same run, and two in flight interleaving them by the seed; the
  shelf's answer lost (the resend is given the unit the shelf gave); the
  cart dying right after the shelf answered; a crash where the shelf
  calls back into the cart (both are reset, nothing was given, and the
  next cart gets the unit); the
  shelf's call to the auditor failing (the watchdog tells it again); and
  the auditor's call back acting with its answer lost (nothing is told
  twice).

The invariants: an item a cart keeps is a unit the shelf gave that cart,
what the shelf marked as audited the auditor has, and the one unit has
one holder.

Building this entry found three faults in how calls between objects were
followed (`docs/roadmap.md`). Each request calls one object: a request
that calls two in parallel has two chains of calls racing in real time
when one invocation runs at a time, which a check reports as a run that
does not replay.
