# r2-orphaned-upload

**The bug.** The upload handler puts the file in R2 under a fresh key and
then inserts the D1 row that names it. The two writes are to different
stores, so nothing makes them one: a crash after the put, or an insert
that fails, leaves an object no row names. The client resends the upload,
which goes under another fresh key, so the first object stays orphaned.

**Why it matters.** Orphans are invisible to the app (nothing lists
them), cost storage forever, and hold user data that a deletion request
will not reach. Ordinary tests never see one: both writes succeed.

**What Eutaxy must report.** `VIOLATED` on `every-object-recorded`, with a
trace showing the put, the fault before the insert committed, the resend
and its own put and insert, and the end-of-run snapshots in which one
object's key appears in no row. `every-row-has-object` holds: the row is
only written after its object.

**The fix.** Record intent first: insert the row as `pending` before the
put, then mark it `committed` after. A crash then leaves a pending row,
which a sweeper (or the retry) can finish or delete, and every object is
named by some row. The second invariant then applies to committed rows
only, `d1Rows("DB", "attachments", [{ column: "status", op: "eq", value: "committed" }])`.
