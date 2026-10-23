# signin-code-rate-limit

**The bug.** The endpoint enforces "one sign-in code per address per
minute" with two statements: a `SELECT` for a recent code, then an
`INSERT` when there is none. Nothing makes the pair atomic. Two requests
for the same address in flight at once both run the `SELECT` before
either runs the `INSERT`, so both pass the check and both send a code.

**Why it matters.** One request at a time the limit holds: the second
request sees the first code and gets 429, so every sequential test
passes. The race needs two invocations of the Worker interleaved at their
D1 statements, which is what a double click or a second tab produces.
The same shape breaks attempt caps and per-IP limits.

**What Eutaxy must report.** `VIOLATED` on `one-code-per-window` with no
fault in the schedule, and a trace in which both `first` reads come before
either `run` insert. With `maxConcurrentInvocations: 1` the scenario is
`BOUNDED`.

**The fix.** Make the check and the write one statement, for example
`INSERT ... SELECT ... WHERE NOT EXISTS (...)` and answer 429 when it
changed no row, or keep the limit in a Durable Object, whose input gate
serialises the read and the write.
