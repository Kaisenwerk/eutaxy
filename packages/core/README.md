# @eutaxy/core

**Purpose.** The pure simulation kernel: effect log, fault model, seeded PRNG, `Platform` interface, schedulers, invariants including `refines`, shrinker, verdicts.

**Public surface.** `seedPrng`, `nextU32`, `nextFloat`, `nextInt`, `fork` (pure PRNG); `emptyLog`, `appendEffect`, `serializeLog`, `digestLog` (effect log); `canonicalJson`; `utf8Encode`, `bytesEqual`; scenario model (`ScenarioSpec`, `validateScenario`, `defaultBounds`, `PlatformData`); invariants (`checkInvariant`, `checkInvariants`, `selectEffects`, `getPath`, `atMostOncePerKey` and `atLeastOnce` shapes); fault model (`FaultKind`, `Schedule`, `decideFault`); the `Platform` and `RunHooks` interfaces; verdicts (`ScenarioVerdict`, `describeVerdict`); shrink candidates (`shrinkCandidates`, `shrinkSize`); `sameViolation`, `recomputePerMessageExpected`; state invariants (`EveryRow`, `Implies`, `Unique`, `StateQuery`, `RowCondition`, `queryRows`, `lastSnapshot`, `rowMatches`); `Platform.finish` and `RunHooks.snapshot` for end-of-run snapshots; `Platform.concurrent` and `RunHooks.running` for concurrent invocations.

**May import.** `@eutaxy/spec`. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4 onward. See `docs/design.md` and `docs/roadmap.md`.
