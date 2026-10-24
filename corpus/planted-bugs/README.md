# Planted-bug corpus

Workers with known bugs, each with the verdict Eutaxy must reach. CI fails if
any is missed. This is the guard against a checker that cannot fail. Nothing
here is published.

Each entry is a directory with:

| File              | Holds                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `worker.ts`       | The Worker under test, unmodified Cloudflare code with the bug in it |
| `wrangler.jsonc`  | Its bindings and triggers                                            |
| `schema.sql`      | D1 schema applied before each run (when the Worker uses D1)          |
| `scenario.sim.ts` | The scenario: how to drive the Worker, what must hold, bounds        |
| `manifest.json`   | The verdict and invariant Eutaxy must report                         |
| `README.md`       | The bug, why it matters, and the fix                                 |
| `domain.ts`       | Optional: the Worker's pure core, with Lemma specs, named in `specs` |

`harness.test.ts` checks every entry is complete and consistent; each
entry's `scenario.test.ts` runs it for real.
