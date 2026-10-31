# service-charge-twice

**The bug.** The orders consumer charges each order through the billing
Worker, reached over a service binding by RPC, and then inserts the order
as paid. Nothing makes the charge idempotent on the order: no check of the
orders table first, no idempotency key the billing Worker honours. A
service-binding call can act on the callee's side and still fail on the
caller's (the answer lost, or the caller dying right after the call); the
handler then throws, Queues redeliver the message, and the redelivery
charges the same order again.

**Why it matters.** In an ordinary test the callee answers every call. The
double charge needs the answer of a call that did charge to be lost, and
the redelivery that Queues guarantee.

**What Eutaxy must report.** `VIOLATED` on `charged-once`, with a trace
showing the charge, then a failure before the delivery completes (the
answer lost, `ambiguous`; the caller crashing right after the call; or the
insert that follows erroring), the redelivery, and the second charge for
the same order id. The invariant
`every-order-charged` holds: the redelivery charges every order at least
once.

**The fix.** Look before charging (a row in `orders` means the order is
paid) or pass an idempotency key the billing Worker honours, and record the
order before the charge so a lost answer is recovered, not repeated.
