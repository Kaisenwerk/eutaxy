# alarm-deliveries

A Durable Object's alarm held to the delivery model `core` proves
(`docs/design.md`, "Fault model and platform model").
- **The object**: `arm` stores whether each delivery of the alarm in turn
  is handled and sets the alarm for now. `alarm` returns when this
  delivery is handled and throws when it is not, so the runtime retries
  it, with the retries so far in `retryCount`.
- **The model**: a failed alarm is retried up to six times, and no more
  often than the scenario's `maxRedeliveries` allows. How often that
  delivers an event is the count `deliveries` gives, whose claims are
  proved.

One object for every list of eight outcomes, armed by a request each, so
the six retries are passed by lists that go on beyond them, and the
retries of all of them interleave by their backoff. The run is made once
under every bound from zero to seven; every alarm is delivered exactly as
often as the model says, attempt by attempt, to a handler that runs once
per delivery (the Worker notes each run). An alarm here fails by its
handler throwing, and none is set again or deleted, so none is superseded.
