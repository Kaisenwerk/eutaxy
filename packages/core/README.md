# @eutaxy/core

**Purpose.** The pure simulation kernel: effect log, fault model, seeded PRNG, `Platform` interface, schedulers, invariants including `refines`, shrinker, verdicts.

**Public surface.** `seedPrng`, `nextU32`, `nextFloat`, `nextInt` (pure PRNG); `emptyLog`, `appendEffect`, `serializeLog`, `digestLog` (effect log); `canonicalJson`; `utf8Encode`; scenario model (`ScenarioSpec`, `validateScenario`, `defaultBounds`, `PlatformData`); invariants (`checkInvariant`, `checkInvariants`, `selectEffects`, `getPath`, the `atMostOncePerKey` and `atLeastOnce` shapes and their constructors with `atLeastOncePerMessage`, which platforms wrap for their drives); fault model (`FaultKind`, `Schedule`, `decideFault`); the `Platform` and `RunHooks` interfaces (`RunHooks.bookkeeping` is the invocation a platform records its own actions under); verdicts (`ScenarioVerdict`, `describeVerdict`); shrink candidates (`shrinkCandidates`); `sameViolation`, `recomputePerMessageExpected`; state invariants (`EveryRow`, `Implies`, `Unique`, `StateQuery`, `RowCondition`, `queryRows`, `lastSnapshot`, `rowMatches`); `Platform.finish` and `RunHooks.snapshot` for end-of-run snapshots; `Platform.concurrent` and `RunHooks.running` for concurrent invocations; `Refines` and `decisionTarget` (the shell follows the core's recorded decisions, not on a stale read); `ScenarioSpec.specs`; spec verdicts (`SpecVerdict`: `Checked`, `Refuted` with its `Counterexample`, `SpecUnknown`; `describeSpecVerdict`).

**Self-check.** `self-check.ts` (not exported, never bundled) gives each invariant checker a form over plain data: drawn effects in small domains, a selector anchored on one of them, the real checker run on the log they make. `self-check.props.ts` states that each agrees with a naive reference written there, sharing no code with the checkers; `eutaxy report packages/core/src` runs them, and `tests/self-check.test.ts` plants bugs in a copy of these sources and requires each refuted. So far: `atMostOncePerKey`, `atLeastOnce`, `everyRow`, `unique`, `implies`, `references` (state rows drawn into snapshots of two targets, a query reading the first snapshot's target or a named one).

**May import.** `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4 onward. See `docs/design.md` and `docs/roadmap.md`.
