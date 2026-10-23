# queue-charge-twice

**The bug.** The consumer POSTs a charge to the payments API and then
acknowledges the message, without an `Idempotency-Key`. Between the charge
going through and the acknowledgement there are two places to die: the
reply may never arrive (the request committed, the caller sees an error), or
the invocation may crash before `ack()`. Either way the message is
redelivered and the API charges again.

**Why it matters.** Every payment provider documents idempotency keys for
exactly this reason, and every at-least-once queue makes the retry happen.

**What Eutaxy must report.** `VIOLATED` on `charged-once`: two effective
`POST`s to `Fetch:payments` for the same order id. The scenario declares the
external with `dedupeBy: "Idempotency-Key"`, so the fix is visible in the
model: send the header and the second request is replayed, not charged.

**The fix.** `headers: { "Idempotency-Key": orderId }`, as in the
`fetch-idempotent` differential entry.
