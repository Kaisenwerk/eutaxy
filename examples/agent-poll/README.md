# Example: an Agent with a schedule and WebSocket connections

A live poll is kept by an Agent, built on the Cloudflare Agents SDK.
Voters connect over WebSockets through the SDK's router and cast a vote;
the Agent checks each voter against a membership API, counts the vote in
its state and tells every connection the new tally. The first vote
schedules the poll to close a minute later, when the Agent writes the
final tally into a table of its own.

## Run the check

From `examples/agent-poll` in the repository:

```sh
pnpm install
pnpm check
```

The scenario in `poll.sim.ts` opens two connections and sends a vote on
each, at once. The Agent runs as written, over real WebSocket
connections, with its state in SQLite and its schedule over the Durable
Object's alarm, which fires in virtual time, so the minute takes no time.
There are no injected faults; two votes in flight are enough. The check
reports:

```
VIOLATED  poll  (seed poll)

Invariant result-counts-every-vote is violated: 2 row(s) of p-1/results in DO:POLL violate the condition: {"votes":1}, {"votes":1}

Schedule (run seed ...), events kept: ann, bob, ann:1, bob:1
  no injected faults
```

Each vote read the tally, then awaited the membership check. An Agent is
a Durable Object, whose input gate holds other events while it waits on
its own storage but not while it awaits an outbound `fetch`, so the
second vote ran meanwhile and read the same tally of 0. Both votes wrote
1, and both scheduled a close: the poll closed twice, and each result
counts one vote where two came in. A test that sends one vote at a time
never sees it.

## The fix

`worker.fixed.ts` checks membership first, then reads and writes the
tally with no await between them, so a vote that arrives meanwhile reads
the tally already taken, and only the first vote schedules the close.
`pnpm check:fixed` reports `BOUNDED` with two votes in flight.

## Using it in your own project

`websocket([...])` opens connections through your Worker's `fetch` and
sends each connection's messages into the object that accepted it;
`maxConcurrentInvocations` above 1 lets them interleave at the object's
I/O. `durableObjectTable` reads a table of the Agent's own storage at the
end of the run.
