# wallet-overdraft-race

**The bug.** A Durable Object wallet withdraws by checking the balance,
paying out through an external payouts API, and then debiting. A Durable
Object processes one event at a time only while it waits on its own
storage: its input gate is open while it awaits an outbound `fetch`
(Cloudflare, Durable Objects: input and output gates). A second
withdrawal therefore runs while the first awaits its payout, sees the
same balance of 100, passes the check, and pays out too. Both debit, and
the balance ends at -40.

**Why it matters.** Each call is correct on its own and the storage
operations are atomic. The race is between the object's own outbound
call and another call into the object, which one call at a time never
produces.

**What Eutaxy must report.** `VIOLATED` on `balance-never-negative` with
no fault, and a trace in which the second `withdraw` call starts before
the first one's payout returns. With `maxConcurrentInvocations: 1` the
scenario is `BOUNDED`, and the fixed wallet (`FixedWallet`) is `BOUNDED`
with two in flight.

**The fix.** Reserve the amount in storage before the payout (and give it
back if the payout fails), so a concurrent withdrawal sees what is left
(`FixedWallet`), or hold the input gate for the whole withdrawal with
`blockConcurrencyWhile` (`GatedWallet`); both are `BOUNDED`.
