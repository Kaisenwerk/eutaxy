// eutaxy: the public API. Platform-specific entry points live under subpaths.
import * as prover from "@eutaxy/prover";

export {
  type AtLeastOnce,
  type AtMostOncePerKey,
  type Bounded,
  type Bounds,
  type BoundsReached,
  type Checked,
  type Conflict,
  type Counterexample,
  checkInvariant,
  checkInvariants,
  describeSpecVerdict,
  describeVerdict,
  type EffectLog,
  type EffectRecord,
  type EffectSelector,
  type EventRef,
  type EveryRow,
  type FaultDecision,
  type FaultKind,
  type Implies,
  type Invariant,
  type Platform,
  type Proven,
  type Refines,
  type Refuted,
  type RowCondition,
  type ScenarioSpec,
  type ScenarioVerdict,
  type Schedule,
  type SpecUnknown,
  type SpecVerdict,
  type StateQuery,
  type Tested,
  type Unique,
  type Unsupported,
  type Violated,
  type Violation,
  validateScenario,
} from "@eutaxy/core";
export {
  type CoreObserver,
  type ExploreOptions,
  explore,
  type ObservedCall,
  observeCore,
  replay,
  restrictSpec,
} from "@eutaxy/engine";
export {
  aggregate,
  checkedRung,
  type EngineId,
  type EngineReport,
  type LadderOptions,
  type ModuleProofs,
  type ProofOutcome,
  type PropertyProof,
  type ProveInput,
  type Prover,
  specLadder,
  type TestedOptions,
  testedRung,
} from "@eutaxy/prover";

/** @deprecated Internal to `eutaxy check` since 0.5.1; removed in 0.6.0. */
export const checkSpecModule = prover.checkSpecModule;
/** @deprecated Internal to `eutaxy check` since 0.5.1; removed in 0.6.0. */
export const lemmaBool = prover.lemmaBool;
/** @deprecated Internal to `eutaxy check` since 0.5.1; removed in 0.6.0. */
export const lemmaUnresolved = prover.lemmaUnresolved;
/** @deprecated Internal to `eutaxy check` since 0.5.1; removed in 0.6.0. */
export type ModulePredicates = prover.ModulePredicates;
export {
  emitRegressionTest,
  type RegressionTestOptions,
  renderJson,
  renderSpecs,
  renderText,
  renderTrace,
} from "@eutaxy/report";
export {
  type Binder,
  type Domain,
  extractSpecs,
  type Formula,
  type FunctionSpec,
  type Guard,
  LemmaSyntaxError,
  type ModuleSpecs,
  type NamedProperty,
  type Property,
  parseProperty,
  printProperty,
} from "@eutaxy/spec";
