---
title: "Two Workers over a service binding"
description: A checkout Worker charging through a payments Worker over RPC, both run for real, the double charge a fresh key per request allows, and the fix.
---

<!--@include: ../../examples/service-binding/README.md-->

## The code

The complete project is [`examples/service-binding`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/service-binding) in the repository.

::: code-group

<<< ../../examples/service-binding/worker.ts

<<< ../../examples/service-binding/payments/worker.ts [payments/worker.ts]

<<< ../../examples/service-binding/checkout.sim.ts

<<< ../../examples/service-binding/worker.fixed.ts

:::
