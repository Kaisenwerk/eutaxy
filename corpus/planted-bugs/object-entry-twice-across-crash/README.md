# object-entry-twice-across-crash

**The bug.** An account object takes deposits. Each one is written twice:
an entry in the ledger, a database every account shares and the object
reaches through its own `env`, and the deposit in the object's own
storage. The object's record is what makes a deposit sent twice count
once. The entry is written first and the record after it, and nothing
ties the two: when the entry was written and the object did not get to
record the deposit (the object was reset right after the statement, or
the statement's answer was lost), the caller's resend finds no record and
writes the entry a second time.

**Why it matters.** The two writes are in two stores with no transaction
across them, and the window between them is inside the object, where no
request-level test reaches: every call into the object either answers or
fails cleanly. It is only reachable when the statement the object runs
through its own binding is something a fault can land on, which is what
the model makes it: an effect of the call the object is serving.

**What Eutaxy must report.** `VIOLATED` on `entered-once`, with one fault
on `D1:LEDGER run`, the object's own statement, and both entries written
by the object: one in the call, one in its resend. Seeded and exhaustive
exploration both find it. `FixedAccount` is `BOUNDED`, seeded and
exhaustively.

**The fix.** Make the write outside one that can be made twice: the
statement inserts only when the ledger holds no entry for the deposit. The
window is still there, and a resend still crosses it, but crossing it
writes nothing.
