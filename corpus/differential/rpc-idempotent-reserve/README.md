# rpc-idempotent-reserve

A correct inventory `WorkerEntrypoint` driven over RPC: `reserve()` is
idempotent on the order id (`INSERT OR IGNORE` under a primary key) and
answers whether this call made the reservation; a non-positive quantity is
an error the caller sees; `reservation()` reads a row back, or `null`. The
differential test checks the proxied run and the raw run (the class
constructed and the method called directly on the real bindings) agree on
every attempt's answer, including the resends of the rejected call and the
caller giving up, and on the final `reservations` table. The same scenario
shows the two invariants holding under faults, because a resend after a
lost answer is a no-op.
