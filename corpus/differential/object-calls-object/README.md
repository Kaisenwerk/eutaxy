# object-calls-object

Three kinds of object call one another through their own `env`: a cart
takes a unit from a shelf and keeps the item; the shelf asks the cart
that is waiting on it how many it may hold, and tells an auditor what it
gave before it answers; the auditor calls back into the shelf. A cart
asked who holds the item asks the shelf. Under
Eutaxy each of those calls is an effect of the invocation the calling
object's code runs as, hosting what the called object does; in the raw
run the objects call each other natively. The two must agree on every
answer and on what each object's tables hold.

Every call is awaited before the object that made it answers: nothing
drives an object's work after its answer in the raw run
(`docs/design.md`, Durable Objects).

The cart copies the shelf's answer rather than returning it as it came.
In the raw run the runtime's own result would keep the call into the
shelf open until it is collected, and the shelf could not be evicted for
the next run; under Eutaxy an object is handed a copy either way (the
gate entry `v0-17-object-calls-object` hands one on).
