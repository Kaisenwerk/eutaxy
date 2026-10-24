// @eutaxy/engine: the run loop, fault injection, exploration and replay. See README.md.
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
export { type ExploreOptions, explore, replay, replayRun, runOnce } from "./explore.ts";
export {
  createScriptedFetch,
  type FetchHooks,
  findExternal,
  findResponse,
  hostMatches,
  installScriptedFetch,
  type ScriptedFetch,
  withoutNetwork,
} from "./fetch.ts";
export {
  type ChoiceOption,
  type Chooser,
  CrashSignal,
  InjectedEffectError,
  Run,
  type RunOptions,
} from "./run.ts";
export { restrictSpec, type ShrinkOptions, type ShrinkResult, shrink } from "./shrink.ts";
