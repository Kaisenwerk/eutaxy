---
title: "A queue consumer over D1"
description: A Cloudflare Queues consumer that records payments in D1, a crash between the insert and the acknowledgement, the duplicate Eutaxy finds and the idempotent fix.
---

<!--@include: ../../examples/payments-queue/README.md-->

## The code

The complete project is [`examples/payments-queue`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/payments-queue) in the repository.

::: code-group

<<< ../../examples/payments-queue/worker.ts

<<< ../../examples/payments-queue/payments.sim.ts

<<< ../../examples/payments-queue/worker.fixed.ts

:::
