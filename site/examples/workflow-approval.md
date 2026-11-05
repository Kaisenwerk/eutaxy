---
title: "A Workflow waiting for an event"
description: An expense approval Workflow that waits for the manager's decision and pays out in a step, the double payout Eutaxy finds when the step runs again, and the fix.
---

<!--@include: ../../examples/workflow-approval/README.md-->

## The code

The complete project is [`examples/workflow-approval`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/workflow-approval) in the repository.

::: code-group

<<< ../../examples/workflow-approval/worker.ts

<<< ../../examples/workflow-approval/expenses.sim.ts

<<< ../../examples/workflow-approval/worker.fixed.ts

:::
