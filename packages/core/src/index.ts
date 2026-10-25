// @eutaxy/core: the pure simulation kernel. See README.md.
export { canonicalJson, type JsonValue } from "./canonical-json.ts";
export { atLeastOnce, atLeastOncePerMessage, atMostOncePerKey } from "./delivery-invariants.ts";
export {
  appendEffect,
  digestLog,
  type EffectKind,
  type EffectLog,
  type EffectRecord,
  emptyLog,
  serializeLog,
} from "./effect-log.ts";
export {
  decideFault,
  type FaultDecision,
  type FaultKind,
  type FaultPolicy,
  planFaults,
  type Schedule,
} from "./faults.ts";
export {
  type AtLeastOnce,
  type AtMostOncePerKey,
  checkInvariant,
  checkInvariants,
  type Invariant,
  recomputePerMessageExpected,
  sameViolation,
  type Violation,
} from "./invariants.ts";
export type {
  DeliveryResult,
  EffectOptions,
  EffectPoint,
  EventRef,
  Invocation,
  Platform,
  RunHooks,
} from "./platform.ts";
export { nextFloat, nextInt, nextU32, type PrngState, seedPrng } from "./prng.ts";
export { decisionTarget, type Refines } from "./refines.ts";
export {
  type Bounds,
  defaultBounds,
  type ExternalDecl,
  type PlatformData,
  type ScenarioSpec,
  type ScriptedResponse,
  validateScenario,
  type WorkerRef,
} from "./scenario.ts";
export { type EffectSelector, getPath, matches, selectEffects } from "./selectors.ts";
export { type ShrinkState, shrinkCandidates } from "./shrink.ts";
export {
  type Checked,
  type Counterexample,
  describeSpecVerdict,
  type Refuted,
  type SpecUnknown,
  type SpecUnknownCause,
  type SpecVerdict,
} from "./spec-verdict.ts";
export {
  type EveryRow,
  type Implies,
  lastSnapshot,
  queryRows,
  type Row,
  type RowCondition,
  rowMatches,
  type StateQuery,
  type Unique,
} from "./state.ts";
export { type JsonExtra, toJson } from "./to-json.ts";
export { utf8Encode } from "./utf8.ts";
export {
  type Bounded,
  type BoundsReached,
  describeVerdict,
  type ScenarioVerdict,
  type Shrunk,
  type Unsupported,
  type UnsupportedCause,
  type Violated,
} from "./verdict.ts";
