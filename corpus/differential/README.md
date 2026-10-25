# Differential corpus

Fault-free scenarios run twice: through Eutaxy's binding proxies and against
the raw bindings with the handler called directly. The per-attempt decisions
and the final D1 and R2 state must agree. A difference is a bug in Eutaxy's proxies
or platform model, never in the Worker. Nothing here is published.

Each entry is a directory with `worker.ts`, `wrangler.jsonc`, `schema.sql`
(when D1 is used), `scenario.sim.ts`, `differential.test.ts` (runs inside
workerd and asserts both sides agree) and `README.md` (what the Worker
exercises). `harness.test.ts` checks every entry is complete.
