# parallel-object-calls

A Worker that awaits calls into two objects together, one invocation at a
time (`docs/design.md`, "Calls in parallel inside one invocation").
- **The Worker**: a transfer posts its debit to one account and its credit
  to the other with `Promise.all`, so both calls are in flight at once.
- **The model**: with one invocation at a time no effect is a turn, and
  which of two such calls lands first would be real time's to say. The first
  run that shows the two calls makes the check start over with every
  asynchronous effect a turn, as with several invocations in flight, so the
  order is the schedule's.

- **After the answer**: each account reports its entry to an audit service
  without the answer waiting for it. With every effect a turn that work
  still runs to rest before the next transfer starts, as one invocation at
  a time has it.

The scenario must be `BOUNDED` with every order run; the second test replays
each order of the first transfer's calls from its schedule; the third
replays a schedule that says nothing of turns and finds the run was made
with them; the fourth holds the accounts' later work to before the next
transfer, under six seeds.
