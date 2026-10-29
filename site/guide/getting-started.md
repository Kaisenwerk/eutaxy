---
description: Install Eutaxy, write a scenario for a Cloudflare Worker, run eutaxy check, read the verdict and the shrunk trace, and fix the bug it finds.
---

# Getting started

This page takes a small queue consumer from "looks fine" to a bug found,
fixed, and kept fixed by a regression test. The complete project is
[`examples/payments-queue`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/payments-queue)
in the repository.

## Requirements

- Node 24 or later.
- A Worker project with a wrangler config (`wrangler.jsonc`, `.json` or
  `.toml`).
- TypeScript 7.1. Until its release, that is `typescript@7.1.0-beta`: the
  spec reader asks your compiler for the types of your functions.
- Optional: [elan](https://elan.lean-lang.org) for the Lean engine and
  Z3 on the `PATH` for the SMT engine. See [Provers](/guide/provers).

## Install

```sh
pnpm add -D eutaxy vitest @cloudflare/vitest-plugin typescript@7.1.0-beta
```

`eutaxy` has no runtime dependencies. Vitest and the Cloudflare Vitest
plugin are peer dependencies: Eutaxy runs your Worker through them, so
your TypeScript loader, workerd and bindings come from your own setup.

## The Worker

A consumer of a `payments` queue that records each payment in D1:

```ts
// worker.ts
export interface Env {
  readonly DB: D1Database;
}

export interface Payment {
  readonly orderId: string;
  readonly amountCents: number;
}

export default {
  async queue(batch: MessageBatch<Payment>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { orderId, amountCents } = message.body;
      await env.DB.prepare("INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2)")
        .bind(orderId, amountCents)
        .run();
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Payment>;
```

```jsonc
// wrangler.jsonc
{
  "name": "payments-queue",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "d1_databases": [{ "binding": "DB", "database_name": "payments", "database_id": "local" }],
  "queues": {
    "consumers": [{ "queue": "payments", "max_batch_size": 1, "max_retries": 3 }]
  }
}
```

```sql
-- schema.sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
```

## Write a scenario

A scenario is a TypeScript file, by convention `*.sim.ts`, whose default
export says how to drive the Worker, what state to set up before each run,
and what must hold afterwards:

```ts
// payments.sim.ts
import {
  atLeastOncePerMessage,
  atMostOncePerKey,
  d1Param,
  d1Schema,
  d1Write,
  defineScenario,
  queue,
} from "eutaxy/cloudflare";

// The messages the queue will deliver.
const payments = queue("payments", [
  { body: { orderId: "o-1", amountCents: 1200 } },
  { body: { orderId: "o-2", amountCents: 500 } },
]);

export default defineScenario({
  name: "payments",
  worker: { entry: "./worker.ts", config: "./wrangler.jsonc" },
  setup: [d1Schema("DB", "./schema.sql")],
  drive: payments,
  invariants: [
    // No order may be recorded twice: the first bound parameter of each committed insert is the order id.
    atMostOncePerKey("payment-recorded-once", d1Write("DB"), d1Param(0)),
    // And no order may be lost.
    atLeastOncePerMessage("every-payment-recorded", payments, d1Write("DB"), d1Param(0), "orderId"),
  ],
  bounds: { maxFaultsPerRun: 1, maxRedeliveries: 2, maxConcurrentInvocations: 1, budgetMs: 2000 },
});
```

`d1Schema` resets the `DB` binding from `schema.sql` before every run.
`d1Write("DB")` selects the D1 statements that committed a change, and
`d1Param(0)` keys each one by its first bound parameter. The
[Scenarios](/guide/scenarios) and [Invariants](/guide/invariants) pages
cover every option.

## Run the check

```sh
npx eutaxy check ./payments.sim.ts
```

`eutaxy check` writes a test and a Vitest config into `.eutaxy/` beside the
scenario, runs your Vitest with the Cloudflare plugin pointed at the
wrangler config, reads the verdict back and removes the directory.

## Read the verdict

```txt
VIOLATED  payments  (seed payments)

Invariant payment-recorded-once is violated: D1:DB run happened twice for key "o-2" (seq 1 and 4)
Keys: "o-2"

Schedule (run seed 2537518072), events kept: msg-2
  ambiguous at msg-2#1 effect #0 (D1:DB run)
Shrunk: 1 event(s) and 0 fault(s) removed in 3 run(s)

Trace:
   seq  invocation  kind      target          op        payload
   0    msg-2#1     call      D1:DB           run       {"args":{"params":["o-2",500],"sql":"INSERT INTO payments (order_id, am…
*  1    msg-2#1     result    D1:DB           run       {"args":{"params":["o-2",500],"sql":"INSERT INTO payments (order_id, am…
   2    msg-2#1     fault     D1:DB           run       {"args":{"params":["o-2",500],"sql":"INSERT INTO payments (order_id, am…
   3    msg-2#2     call      D1:DB           run       {"args":{"params":["o-2",500],"sql":"INSERT INTO payments (order_id, am…
*  4    msg-2#2     result    D1:DB           run       {"args":{"params":["o-2",500],"sql":"INSERT INTO payments (order_id, am…
   5    msg-2#2     call      Queue:payments  ack       {"args":{"body":{"amountCents":500,"orderId":"o-2"},"implicit":false,"m…
   6    msg-2#2     result    Queue:payments  ack       {"args":{"body":{"amountCents":500,"orderId":"o-2"},"implicit":false,"m…
   7    platform    snapshot  D1:DB           snapshot  {"tables":{"payments":[{"amount_cents":500,"id":1,"order_id":"o-2"},{"a…

Explored: 8 run(s), 18 effect point(s), 3 fault(s) injected, 38 ms
Assumptions:
  - schedule points are effect boundaries: proxied bindings, patched timers and fetch; other awaits run in program order
  - …

Regression test written to payments.regression.test.ts
```

Read it from the top:
- **The invariant and the keys.** Order `o-2` was inserted twice.
- **The schedule.** One fault explains it: `ambiguous` at the first effect
  of the first attempt at message `msg-2`. The insert committed, but the
  Worker saw an error, so the handler threw and the queue redelivered the
  message (`msg-2#2`), which inserted it again.
- **Shrunk.** Message `msg-1` was not needed to reproduce the violation,
  so it was removed; the kept schedule replays the violation on its own.
- **The trace.** Every effect, in order, with the two offending records
  starred.
- **Assumptions.** Everything the verdict rests on: the fault model, the
  platform model, the virtual clock. A verdict is only as good as these,
  so they are always printed.

The exit code is 1 for `VIOLATED`. With `--json`, the same report is one
object in a versioned schema for CI and coding agents.

## Fix it

Make the insert idempotent on the order id:

```sql
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL
);
```

```ts
await env.DB.prepare(
  "INSERT INTO payments (order_id, amount_cents) VALUES (?1, ?2) ON CONFLICT (order_id) DO NOTHING",
)
  .bind(orderId, amountCents)
  .run();
```

A redelivered message now changes nothing, and `d1Write` does not select an
insert that changed no row. Run the check again:

```txt
BOUNDED  payments  (seed payments)

No violation found within the stated bounds. This is not a proof.
Bounds: faults per run ≤ 1, redeliveries ≤ 2, concurrent invocations ≤ 1, budget 2000 ms
```

`BOUNDED` is the strongest thing a simulation can say: no violation in any
explored run within the stated bounds. Raise the bounds, run every schedule
with `--exhaustive`, or prove the core with a [prover](/guide/provers) for
more.

## Keep it fixed

On a violation, `eutaxy check` writes `payments.regression.test.ts` next to
the scenario. It replays the shrunk schedule on the kept events inside
workerd and expects the invariants to hold, so it fails while the bug
exists and passes once it is fixed. Commit it, and run it with the rest of
your Vitest suite under the Cloudflare Vitest plugin. Regenerate it rather
than editing it.

## Next steps

- [Scenarios](/guide/scenarios): HTTP drives, concurrency, externals,
  Durable Objects, R2 and Workflows.
- [Specs](/guide/specs): properties of the pure core, checked on the
  simulation's own inputs.
- [CLI](/reference/cli): every flag and exit code.
