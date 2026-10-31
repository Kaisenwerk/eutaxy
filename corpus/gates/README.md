# Phase gates

One Worker per roadmap phase, written the way the phase's target systems are
and using everything the phase added. Its scenarios must run with no
`UNSUPPORTED` verdict and hold their invariants: the gate `docs/roadmap.md`
names for the phase, passing in CI. Unlike the planted-bug corpus, nothing
here is wrong on purpose. Nothing here is published.

Each entry is a directory with `worker.ts`, `wrangler.jsonc`, `schema.sql`
(when D1 is used), one or more `*.sim.ts` scenarios, `scenario.test.ts`
(runs inside workerd and asserts the verdicts) and `README.md` (what the
Worker exercises and which gate it is). `harness.test.ts` checks every
entry is complete.
