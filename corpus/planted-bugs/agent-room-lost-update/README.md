# agent-room-lost-update

**The bug.** A chat room is kept by a class built on the Cloudflare Agents
SDK, reached over WebSocket connections. Each message is checked by an
external moderation API, counted in the Agent's state and in a table of
the Agent's own (`this.sql`), and the count is broadcast to every
connection. A message reads the count, awaits the moderation call, then
writes the count plus one. An Agent is a Durable Object, whose input gate
holds other events only while it waits on its own storage, not while it
awaits an outbound `fetch`, so a message from a second connection runs
while the first awaits moderation, reads the same count of 0, and takes
the count 1 too: the `counts` table holds 1 twice, and every client is
told the room holds one message where two arrived.

**Why it matters.** The Agent runs as written over real WebSocket
connections: the scenario opens two, through the SDK's router, and sends
a message on each; the messages are delivered inside the object, the
SDK's protocol frames and the room's broadcasts arrive on the client ends
and are recorded per connection. Nothing is modelled; the race is the
object's, and it shows in a table the Agent's own storage holds.

**What Eutaxy must report.** `VIOLATED` on `each-message-counted-once`
with no fault: two rows of the `counts` table share the value 1. The
fixed room (`FixedRoom`), which writes the state and the count before the
moderation call, is `BOUNDED` with two in flight.

**The fix.** Take the count before the outbound call, so a concurrent
message reads the count already taken.
