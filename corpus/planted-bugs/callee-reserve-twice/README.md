# callee-reserve-twice

**The bug.** The storefront's orders consumer reserves stock through the
inventory Worker, reached over a service binding by RPC, under an idempotency
key it draws with `crypto.randomUUID()` on each attempt, then records the
order with its reservation. The inventory Worker honours the key: a resend
with the same key finds its reservation and answers it again. A
service-binding call can act on the callee's side and still fail on the
caller's (the answer lost, the caller dying right after the call, or the
insert that follows erroring); the handler then throws, Queues redeliver the
message, and the redelivery draws a new key and reserves the same order a
second time. Each Worker keeps its own contract; the system holds two
reservations for one order.

**Why it matters.** The bug crosses the two Workers. Checking the inventory
Worker alone with a retrying caller (the `rpc` drive resends the same
arguments) passes: it is idempotent per key. Checking the storefront alone
with the inventory Worker scripted (`scripted.sim.ts`) passes too: each key
is used once and every order holds a reservation. Only a run of both
Workers' real code sees the second reservation.

**What Eutaxy must report.** `VIOLATED` on `one-reservation-per-order`, a
state invariant over the inventory Worker's database (`inventory/DB`), with
a trace showing the reserve call hosting the inventory Worker's invocation
(`msg-1#1/INVENTORY.reserve`), a failure before the delivery completes, the
redelivery, and a second reservation for the same order under a new key.
`every-order-reserved` and `every-order-holds-a-reservation` hold. The same
scenario with the callee scripted ends `BOUNDED`.

**The fix.** Derive the key from the order (or the message id), so a resend
carries the same key; or make the inventory Worker idempotent per order.
