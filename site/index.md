---
layout: home
title: Eutaxy — Deterministic simulation and formal proof for Cloudflare Workers
titleTemplate: false
description: Eutaxy finds the bugs that crashes, retries and concurrency cause in Cloudflare Workers by deterministic simulation, and proves your TypeScript core in Lean 4 and Z3.

hero:
  name: Eutaxy
  text: Deterministic simulation and formal proof for Cloudflare Workers
  tagline: Find the bugs that crashes, retries and concurrency cause before production does, and prove the business logic underneath for every input.
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: Eutaxy
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Eutaxy?
      link: /guide/what-is-eutaxy
    - theme: alt
      text: View on GitHub
      link: https://github.com/Kaisenwerk/eutaxy

features:
  - title: Your Worker, unmodified
    details: Runs your real Worker inside workerd through your own Vitest and the Cloudflare Vitest plugin. D1, Queues, Durable Objects with alarms and R2 are the real local bindings, wrapped rather than mocked.
    link: /platforms/cloudflare
    linkText: Supported bindings
  - title: Faults at every effect
    details: Crashes before and after each effect, lost replies, clean errors, redeliveries and cut-off background work, injected at every binding call and outbound fetch.
    link: /guide/faults
    linkText: The fault model
  - title: Concurrency, interleaved
    details: Concurrent invocations interleave at their I/O, under a seeded scheduler or over every schedule within the bounds, with partial-order reduction.
    link: /guide/faults#exhaustive-exploration
    linkText: Exploration
  - title: Replayable counterexamples
    details: A violation comes back replayed and shrunk, with its full effect trace, and as a Vitest regression test that fails until the bug is fixed.
    link: /guide/getting-started#read-the-verdict
    linkText: See one
  - title: Specs in TypeScript
    details: Properties of your pure core are written with forall in TypeScript, checked on the inputs the simulation produced, then on generated inputs.
    link: /guide/specs
    linkText: Writing specs
  - title: Proofs that name their engine
    details: First-party engines prove properties for every input in Lean 4 or with Z3. When they disagree the verdict is CONFLICT, and nothing sampled is ever called verified.
    link: /guide/provers
    linkText: The provers
---

## The bug an ordinary test misses

This queue consumer records each payment in D1 and acknowledges the
message. It passes every unit test you would think to write.

```ts
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

A scenario beside it says what must hold: every payment recorded, none
recorded twice. `eutaxy check` runs the Worker inside workerd, injects
faults at every effect, redelivers messages the way Cloudflare Queues does,
and finds the run that breaks it:

```txt
VIOLATED  payments  (seed payments)

Invariant payment-recorded-once is violated: D1:DB run happened twice for key "o-2" (seq 1 and 4)

Schedule (run seed 2537518072), events kept: msg-2
  ambiguous at msg-2#1 effect #0 (D1:DB run)
Shrunk: 1 event(s) and 0 fault(s) removed in 3 run(s)
```

The insert committed but its answer was lost, the handler threw, the queue
redelivered the message, and the order was recorded twice. The same seed
replays the same run on every machine, and the regression test Eutaxy
writes fails until the insert is idempotent.

## Install

```sh
pnpm add -D eutaxy vitest @cloudflare/vitest-plugin typescript@7.1.0-beta
```

Eutaxy needs Node 24 and TypeScript 7.1. It has no runtime dependencies;
the prover toolchains (Lean 4, Z3) are optional. Continue with
[Getting started](/guide/getting-started).
