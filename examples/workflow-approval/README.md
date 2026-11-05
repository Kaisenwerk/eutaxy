# Example: a Workflow waiting for an event

An expense approval runs as a Cloudflare Workflow. Submitting an expense
starts an instance, which waits up to a week for the manager's decision;
a later request delivers the decision to it as an event. Once approved,
the instance pays the employee through a payouts API, inside `step.do`,
so that a restart of the Workflow does not pay again.

## Run the check

From `examples/workflow-approval` in the repository:

```sh
pnpm install
pnpm check
```

The scenario in `expenses.sim.ts` submits one expense and then approves
it. The Workflow runs on a model of the engine: the wait suspends the
instance until the event arrives, each step attempt can crash before it
runs or after it ran, and a failed step is retried on the engine's
schedule in virtual time. The check reports:

```
VIOLATED  expenses  (seed expenses)

Invariant paid-once is violated: Fetch:payouts POST happened twice for key "exp-1" (seq 15 and 22)

Schedule (run seed ...), events kept: req-1, req-2
  crash_after at workflow:APPROVALS:exp-1#1 effect #3 (Workflow:APPROVALS step_result)
```

The payout step ran, and the engine restarted before its result was
saved, so the step ran again and paid a second time. A step is retried
the same way when its call fails after the far side acted (with `--seed
example` the check finds that path: the payouts API's answer lost). Steps
make a Workflow's code run once per completed step, not once per effect;
an ordinary test, where every step completes the first time, cannot tell
the two apart.

## The fix

`worker.fixed.ts` sends the payout with an idempotency key derived from
the expense, which the payouts API deduplicates by (the scenario's
`external` declares that guarantee with `dedupeBy`), so a step that runs
again is answered with the first payout. `pnpm check:fixed` reports
`BOUNDED`.

## Using it in your own project

`workflow(binding, className)` names the Workflow and the class its
instances run; `workflowRows` reads the instances at the end of the run.
An outbound call is answered from the scenario's `external` declarations:
declare each host your Workflow reaches, with `dedupeBy` when the service
promises to deduplicate.
