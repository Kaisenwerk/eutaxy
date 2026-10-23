# lease-pool-lost-response

**The bug.** A Durable Object hands out leases on a fixed set of slots.
The Worker asks it for a lease for a project and retries a failed call
once, with the same token. `acquire` takes the first free slot without
checking whether the project already holds one. When the pool commits
the lease and the answer is lost on the way back, the retry takes a
second slot, and the project holds two.

**Why it matters.** Retrying a call that failed before it reached the
object is correct, and so is the transaction inside the object: the
input gate and the transaction make each `acquire` atomic. The bug only
shows when a call reaches the object, commits, and its answer is lost,
which no ordinary test produces.

**What Eutaxy must report.** `VIOLATED` on `one-slot-per-project`, with an
`ambiguous` fault on the first `acquire` and two slots leased to `p-1` in
the pool's storage. The fixed pool (`FixedLeasePool`), which returns the
existing lease when the project and token match, is `BOUNDED`.

**The fix.** Look the project up first: return its lease when the token
matches (a retry), refuse when it does not (another holder).
