# object-resets-itself

An object that resets itself with its own `ctx.abort()`
(`docs/design.md`, "Durable Objects").
- **The object**: `quit` aborts the object from inside it: the call fails
  with the reason given, the instance is gone, and what the object held in
  memory with it. `quitLater` answers first and aborts a moment later, so
  no call fails. `refuse` only throws: the instance lives on.
- **The model**: the simulation resets an object itself where it injects a
  crash, and then accounts for what the object had in flight. A reset the
  object makes is not the simulation's, so the run is `UNSUPPORTED` and
  says so, the moment the object's code calls `ctx.abort()`, whether or
  not anything calls the object again. An ordinary failure is no reset:
  the next call enters the same instance.

Six scenarios: a later request calls the object after its reset; the same
request calls it again; nothing calls it again; the object resets itself
after it has answered; it resets itself twice, and is named once; and a
call that only fails, which stays `BOUNDED`.
