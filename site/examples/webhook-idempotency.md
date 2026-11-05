---
title: "A webhook with an idempotency key"
description: A payment webhook that skips events it has seen, a lost answer from D1 between two writes, the double credit Eutaxy finds and the fix that keys the write itself.
---

<!--@include: ../../examples/webhook-idempotency/README.md-->

## The code

The complete project is [`examples/webhook-idempotency`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/webhook-idempotency) in the repository.

::: code-group

<<< ../../examples/webhook-idempotency/worker.ts

<<< ../../examples/webhook-idempotency/deposits.sim.ts

<<< ../../examples/webhook-idempotency/worker.fixed.ts

:::
