# Eutaxy

Deterministic simulation and formal proof for TypeScript on Cloudflare
Workers.

Eutaxy runs unmodified Worker code with its bindings wrapped (D1, and
Durable Objects with their alarms; outbound `fetch` is answered from the
externals a scenario declares), injects faults at every effect boundary,
interleaves concurrent invocations at their I/O, and checks invariants over
the effect log. It explores runs from a seed, or every schedule within the
bounds. The same engine checks AWS Lambda functions consuming SQS with
DynamoDB, through the AWS SDK as the effect boundary. A failure in a Worker
comes back as a shrunk, replayable trace plus a Vitest regression test that
runs in workerd.

Specs on a Worker's pure core functions are checked on the inputs the
simulator actually passed them, then on generated inputs, and proved in
Lean 4 when `--prover lean` is given; `refines` checks that the Worker
carries out the core's decisions on state that was still current.

**Status: 0.6, early.** The design is in
[docs/design.md](docs/design.md); the phases and their gates are in
[docs/roadmap.md](docs/roadmap.md).

## Verdicts

A scenario gets `VIOLATED`, `BOUNDED` or `UNSUPPORTED`. A spec gets
`CHECKED` (held on every input the simulator passed), `TESTED` (held on
those and on inputs generated from the property's domains), `REFUTED`
(with the input that breaks it, shrunk), `PROVEN` (for every input, by a
named engine; `eutaxy check --prover lean` runs Eutaxy's own
TypeScript-to-Lean 4 engine, which proves properties of a pure subset over
integers, booleans, strings and records today), `CONFLICT` (engines disagree) or
`UNKNOWN`. Every verdict carries what it rests on:
seed and bounds, or the inputs it was checked on, and the assumptions.
Nothing is ever reported as verified when it was only explored or sampled:
`BOUNDED`, `CHECKED` and `TESTED` are not proofs.

## Repository

```
packages/   spec, core, engine, cloudflare, aws, prover, prover-lean,
            prover-thales, prover-lemmascript, report, cli, eutaxy
docs/       design and roadmap
```

Dependencies point down into a pure, dependency-free core. Each package's
`README.md` states its purpose, public surface and what it may import; each
declares exactly that, and pnpm links nothing else.

## Installing

```sh
pnpm add -D eutaxy vitest @cloudflare/vitest-plugin
```

Requires Node 24. Published as `eutaxy` on npm.

## Checking a Worker

Write a scenario beside your Worker and run the check:

```sh
eutaxy check ./payments.sim.ts
```

[examples/payments-queue](examples/payments-queue) is a complete, runnable
version of this: a queue consumer with a bug the check finds, and the fixed
Worker it reports `BOUNDED` for.

A scenario drives the Worker through its `queue()` handler or, with
`http(...)`, through its `fetch()` handler, where the caller's retry policy
(a webhook provider resending until it gets a 2xx) decides redelivery. With
`maxConcurrentInvocations` above 1, invocations run concurrently and
interleave at their I/O, including a Durable Object's outbound I/O during
a call (its storage operations hold other events, as the runtime's input
gate does); alarms fire in virtual time. A scenario's `specs` names the
modules of its pure core; each module's specs live in a spec file beside
it (`domain.ts` has `domain.props.ts`), written in TypeScript so your own
compiler checks them against the functions they describe:

```ts
import { forall } from "eutaxy/spec";
import { decideRefund } from "./domain.ts";

export const withinCaptured = forall(decideRefund, {
  when: (captured, refunded) => 0 <= refunded && refunded <= captured,
  ensures: (captured, refunded, amount) =>
    decideRefund(captured, refunded, amount).refunded <= captured,
});
```

Each property is checked on the inputs the simulator passed (`CHECKED`),
then on inputs drawn from the parameter types (`TESTED`), and proved for
every input by a named engine (`PROVEN`): `--prover lean` proves under an
integer model of `number` with the Lean 4 kernel, `--prover smt` proves
over the doubles themselves with Z3 and replays every model it finds, and
`--prover lean,smt` reports a `CONFLICT` where the two disagree.

It runs the scenario inside workerd through your Vitest and the Cloudflare
Vitest plugin, prints the verdict with its trace and assumptions (or
`--json`; `--exhaustive` runs every schedule within the bounds), and on a
violation writes `payments.regression.test.ts`, which fails while the bug
exists and passes once it is fixed. It exits 0 for `BOUNDED`, 1 for
`VIOLATED` or a `REFUTED` spec, 2 for `UNSUPPORTED`, and 3 on an error.

## Developing

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm check      # lint, typecheck, test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
