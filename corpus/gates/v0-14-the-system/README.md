# v0-14-the-system

The v0.14 gate (`docs/roadmap.md`, "The system"): a storefront calling the
inventory Worker through a service binding, both Workers' real code in one
simulation, checked through `eutaxy check` from the two wrangler configs.
- **The call path**: `reserve` and `fulfil` over RPC, each hosting the
  inventory Worker's invocation; its D1 database under `inventory/DB`.
- **A shared resource**: the stock objects live in the inventory Worker's
  script; the storefront binds the class with `script_name` and reads the
  stock left directly. One namespace, set up and snapshotted under the
  storefront's name (`STOCK`); the inventory Worker's `STOCK` is its alias.
- **The callee's Workflow**: fulfilment runs the inventory Worker's
  `Fulfilment` class with the inventory Worker's env.
- **Two orders at once**: two invocations in flight, their calls and the
  callees' effects interleaved by the scheduler.

The scenario must be `BOUNDED`: every step is idempotent on the order, so a
lost answer and the resend that follows change nothing. The test runs the
command (this entry has no `scenario.test.ts`: the storefront's config names
the inventory Worker by its real name, which only the command's isolate
provides). The planted bug this phase catches, which the same scenario with
the callee scripted misses, is `corpus/planted-bugs/callee-reserve-twice`.
