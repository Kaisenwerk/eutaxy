---
title: "An Agent with a schedule and WebSockets"
description: A live poll kept by an Agents SDK class over WebSocket connections, closed by a schedule, the lost vote two voters at once produce, and the fix.
---

<!--@include: ../../examples/agent-poll/README.md-->

## The code

The complete project is [`examples/agent-poll`](https://github.com/Kaisenwerk/eutaxy/tree/main/examples/agent-poll) in the repository.

::: code-group

<<< ../../examples/agent-poll/worker.ts

<<< ../../examples/agent-poll/poll.sim.ts

<<< ../../examples/agent-poll/worker.fixed.ts

:::
