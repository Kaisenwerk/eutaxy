# d1-ledger

A correct ledger consumer that touches every modelled D1 operation per
message: an idempotent `INSERT OR IGNORE`, a `first()` lookup, a two-statement
`batch()`, an `all()` read, a `raw()` count and an `exec()`. The differential
test checks the proxied run and the raw run agree on every attempt and on the
final `accounts` and `postings` tables. The same scenario also shows the two
state invariants holding, with and without faults, because the Worker is
idempotent on `posting_id`.
