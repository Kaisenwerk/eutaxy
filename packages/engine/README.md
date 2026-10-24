# @eutaxy/engine

**Purpose.** The platform-neutral run loop: virtual clock, globals patching, per-run state reset, replay, and the turns of concurrent invocations.

**Public surface.** `explore` (seeded or, with `exhaustive`, every schedule within the bounds with partial-order reduction; replay, shrink, verdict), `Chooser` and `ChoiceOption` (how exhaustive runs make their choices), `replay` and `replayRun` (re-run a schedule exactly), `shrink` and `restrictSpec`, `runOnce`, `Run` (the per-run hooks proxies call), `CrashSignal`, `InjectedEffectError`. `observeCore` (wraps a module namespace's functions so calls made while a run is installed are recorded, with their arguments, and logged as decisions of the invocation running; `Run.decision` is where they land), `summarize`. `patchGlobals`, `VirtualClock`, `VirtualRandom`, `settleOn` (the virtual clock and the globals patch; `Run.install`/`uninstall` apply them per run and `Run.settle` waits under them).

**May import.** `@eutaxy/core`, and from the host only what it patches:
`node:async_hooks` (through `process.getBuiltinModule`, so a host without it
still loads) to keep an SDK's timers real during an effect's I/O while the
handler's stay virtual. Only these are declared in `package.json`, and
pnpm links only declared workspace dependencies, so an import of any other
package does not resolve. The project references in `tsconfig.json` mirror the
list; a test keeps the two in sync with the design.

**Phase.** v0.4. See `docs/design.md` and `docs/roadmap.md`.
