// @eutaxy/engine: the run loop, fault injection, exploration and replay. See README.md.
export {
  type ChoiceOption,
  type Chooser,
  type FaultPlacement,
  limitFaults,
  replayChooser,
  seededChooser,
} from "./chooser.ts";
export {
  effectLatencyMs,
  type Patched,
  patchGlobals,
  realTick,
  type SettleContext,
  settleOn,
  VirtualClock,
  VirtualRandom,
  virtualEpoch,
} from "./clock.ts";
export { type Outcome, runInvocation } from "./deliver.ts";
export { type ComparedSide, compareSides, DifferentialStuck, proxiedSide } from "./differential.ts";
export { type ExploreOptions, explore, replay, replayRun, runOnce } from "./explore.ts";
export {
  createScriptedFetch,
  type FetchHooks,
  findExternal,
  findResponse,
  hostMatches,
  installScriptedFetch,
  isRedirect,
  parseBody,
  type Reply,
  replyOf,
  type ScriptedFetch,
  toResponse,
  withoutNetwork,
} from "./fetch.ts";
export { type CoreObserver, type ObservedCall, observeCore } from "./observe.ts";
export { patchProperty } from "./patch.ts";
export { CrashSignal, InjectedEffectError, Run, type RunOptions } from "./run.ts";
export { restrictSpec, type ShrinkOptions, type ShrinkResult, shrink } from "./shrink.ts";
