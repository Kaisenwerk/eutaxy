# agent-tally-lost-update

**The bug.** A tally is kept by a class built on the Cloudflare Agents
SDK: its state is the count, a hit audits itself through an external API,
and a schedule set on the first hit flushes the count into a SQL table of
the Agent's own (`this.sql`). A hit reads the count, awaits the audit, then
writes the count plus one. An Agent is a Durable Object, whose input gate
holds other events only while it waits on its own storage, not while it
awaits an outbound `fetch`, so a second hit runs while the first awaits
its audit, reads the same count of 0, and writes 1 too. The flush, run
from the schedule over the object's alarm, records 1 where 2 hits came in.

**Why it matters.** The Agent runs as written: its state in SQLite, its
`this.sql` table, its schedule over the Durable Object alarm, and the
SDK's router walking the Worker's bindings. Nothing here is modelled; the
race is the object's, and it shows in a table the SDK's own storage holds.

**What Eutaxy must report.** `VIOLATED` on `flush-counts-both-hits` with
no fault: the `flushes` table of the Agent `t-1`, read from its SQLite
storage, holds rows whose count is 1. The fixed Agent (`FixedTally`), which
writes the state before the audit call, is `BOUNDED` with two in flight.

**The fix.** Write the state before the outbound call, so a concurrent hit
reads the count already taken.
