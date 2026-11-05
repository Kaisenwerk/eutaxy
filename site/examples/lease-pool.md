---
title: "A lease pool object with an alarm"
description: A SQLite-backed Durable Object that leases runners and reclaims them from its alarm, a lost answer and a retry that takes a second runner, and the fix.
---

<!--@include: ../../examples/lease-pool/README.md-->

## The code

The complete project is [`examples/lease-pool`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/lease-pool) in the repository.

::: code-group

<<< ../../examples/lease-pool/worker.ts

<<< ../../examples/lease-pool/leases.sim.ts

<<< ../../examples/lease-pool/worker.fixed.ts

:::
