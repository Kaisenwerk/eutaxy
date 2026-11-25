# unsupported-replay

The test `eutaxy check` writes for an `UNSUPPORTED` verdict
(`docs/roadmap.md`, v0.18, pinned schedules). An orders queue consumer
records each order once and tells an audit service when a message comes
again for an order it already has. The scenario does not declare the audit
service, so a run where the insert's answer is lost (`ambiguous`) and the
message is redelivered calls a host outside the model, and the check is
`UNSUPPORTED` (`unsupported_api`).

The verdict carries that run as a pinned schedule (`replay`): its fault at
the insert, by the call's target, op and arguments and its number among the
run's calls with the same three, not by the invocation and position its
schedule records. `regression.test.ts` is the file `eutaxy check --seed
corpus` wrote for it, committed as written; it replays the run with
`runPinned` and expects the same reason. `scenario.test.ts` checks the
verdict and that the emitter still writes that file.
