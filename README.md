# Eutaxy

Deterministic simulation and formal proof for TypeScript on Cloudflare
Workers.

Eutaxy runs unmodified Worker code with its bindings wrapped, injects faults
at every effect boundary, explores runs from a seed, and checks invariants
over the effect log. The same engine checks AWS Lambda functions consuming
SQS with DynamoDB, through the AWS SDK as the effect boundary. A failure comes back as a shrunk, replayable trace plus
a Vitest regression test that runs in workerd. Specs on pure core functions
are checked on simulated inputs, then on generated inputs, then optionally
proved in Lean 4.

**Status: 0.4, early.** The design is in
[docs/design.md](docs/design.md); the phases and their gates are in
[docs/roadmap.md](docs/roadmap.md).

## Verdicts

A scenario gets `VIOLATED`, `BOUNDED` or `UNSUPPORTED`. A spec gets
`CHECKED`, `TESTED` or `PROVEN`, or `REFUTED`, `UNKNOWN` or `CONFLICT`. Every
verdict carries what it rests on: seed and bounds, or engine, version and
assumptions. Nothing is ever reported as verified when it was only explored.

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
(a webhook provider resending until it gets a 2xx) decides redelivery.

It runs the scenario inside workerd through your Vitest and the Cloudflare
Vitest plugin, prints the verdict with its trace and assumptions (or
`--json`), and on a violation writes `payments.regression.test.ts`, which
fails while the bug exists and passes once it is fixed.

## Developing

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm check      # lint, typecheck, test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
