---
description: Eutaxy is a deterministic simulation testing tool for Cloudflare Workers that also proves properties of the pure TypeScript core in Lean 4 and Z3. What it checks, how, and what its verdicts mean.
---

# What is Eutaxy?

Eutaxy is a deterministic simulation checker for TypeScript on Cloudflare
Workers, joined to formal proof of the Worker's pure core. It runs your
unmodified Worker with its bindings wrapped, injects faults at every
effect boundary, interleaves concurrent invocations at their I/O, and
checks invariants over the log of effects. A failure comes back as a
shrunk, replayable trace and a Vitest regression test that runs in
workerd.

## Three questions, three kinds of verdict

Eutaxy answers three separate questions, and never blurs their answers
together:
1. **Does the code survive crashes, retries and concurrency?** The
   simulator explores fault points and interleavings within stated bounds
   and reports `VIOLATED`, `BOUNDED` or `UNSUPPORTED`.
2. **Is the business logic right for every input?** Specs on pure core
   functions are checked on the inputs the simulator produced
   (`CHECKED`), then on generated inputs (`TESTED`), then proved by an
   engine (`PROVEN`).
3. **Does the running code follow that logic?** The
   [`refines`](/guide/invariants#refines) invariant checks that every
   effect the Worker performs carries out what the core decided, on state
   that was still current when the effect committed.

See [Verdicts](/guide/verdicts) for every verdict and what it rests on.

## Deterministic simulation testing

Distributed bugs hide in the orderings and failures a normal test never
produces: a write that committed but whose answer was lost, a message
delivered twice, two requests reading the same row before either writes.
Deterministic simulation testing makes those runs reachable and
repeatable. Everything that could vary between runs is put under the
control of one seed:
- **Time and randomness.** `Date`, `Math.random`, `crypto.randomUUID`,
  `crypto.getRandomValues`, `performance.now` and timers are virtual for
  the duration of a run.
- **Faults.** At each effect (a D1 statement, a queue acknowledgement, a
  Durable Object call, an outbound `fetch`) the run may crash before or
  after it, lose its reply, or fail it cleanly.
- **Delivery.** Queue messages, alarms and Workflow steps are redelivered
  the way Cloudflare documents, and inbound requests are resent by a
  caller with the retry policy you declare.
- **Scheduling.** With concurrent invocations, which one runs next at each
  I/O point is a choice the seed makes, or one the exhaustive mode
  enumerates.

The same seed and inputs produce a byte-identical trace on every machine,
so a violation found once can be replayed, shrunk and turned into a test.

## Real runtime, not a mock

Eutaxy does not re-implement Cloudflare. Your Worker runs inside workerd
through your own Vitest and the Cloudflare Vitest plugin; D1 is
Miniflare's real SQLite, Durable Objects are the objects workerd runs, with
their own storage, transactions and input and output gates, and R2 buckets
are Miniflare's. Eutaxy wraps the boundary your Worker crosses, records
each call as an effect and decides the faults. The one model is the
Workflows engine, whose local implementation cannot be restarted at the
points that matter. A differential corpus runs fault-free scenarios
both through Eutaxy and directly against the raw bindings and requires the
two to agree.

Anything Eutaxy cannot control makes a run `UNSUPPORTED` instead of
passing quietly: an unproxied binding, a request to a host the scenario did
not declare, an invocation waiting on something outside the simulation.

## Proofs of the pure core

Well-structured Workers keep their decisions in pure functions (should
this refund go through, which lease is free, what is the next state) and
their effects in a thin shell around them. Eutaxy specs those functions in
TypeScript, beside the module:

```ts
import { forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";

export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded, amount) =>
    Number.isInteger(amount) && 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
```

Your own compiler types the claim's parameters as the function's, so a
spec that drifts from its function stops compiling. Two first-party
engines then prove such properties for every input: one translates the
function to Lean 4 and has the Lean kernel check the proof, the other
emits SMT-LIB and decides it with Z3 over IEEE doubles. See
[Specs](/guide/specs) and [Provers](/guide/provers).

## What Eutaxy does not claim

- `BOUNDED` means no violation was found within the stated bounds. It is
  not a proof, and the report says so in those words.
- `CHECKED` and `TESTED` mean a property held on the inputs tried. Only
  `PROVEN` covers every input, and it always names its engine and the
  model of the language it assumed.
- Production-only behaviour the simulator cannot see, such as D1 read
  replication, real queue batching and real latency, is out of scope.

## Status

Eutaxy is early: its API follows semantic versioning, and breaking changes
come with a changelog entry and a migration note. Cloudflare Workers are
the first platform; [AWS Lambda with SQS and DynamoDB](/platforms/aws) is
the second. The phases and what each one shipped are in the
[roadmap](/reference/roadmap), and the full design in the
[design document](/reference/design).
