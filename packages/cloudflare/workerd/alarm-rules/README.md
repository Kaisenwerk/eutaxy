# alarm-rules

A Durable Object's alarm held to the alarm's rules, whose claims are
proved (`docs/design.md`, "Fault model and platform model";
`src/alarm-rules.props.ts`).
- **The object**: `arm` sets the alarm, then makes each change it was
  told in turn, setting the alarm again or deleting it, each alarm due a
  second before the one set before it. `alarm` notes its run and, when
  the object was armed to fail, throws, so the runtime retries it.
- **The rules**: every `setAlarm` or `deleteAlarm` starts a new
  generation, and an alarm event of another generation is superseded; a
  failed alarm is retried six times, after two seconds and then twice as
  long each time.

One object for every list of up to four changes, armed by a request
each: every setting makes an event, and exactly the events the rule does
not call superseded run the handler, which is the last one when the last
change set an alarm and none when it deleted it. A replaced alarm is
still pending when its replacement fires and comes due after it. A
second run arms one object whose alarm always fails: its handler runs
seven times, and the six waits are the rule's, two seconds doubled to
sixty-four. A retry superseded between a failure and its retry is held
in Node (`src/alarms.test.ts`).
