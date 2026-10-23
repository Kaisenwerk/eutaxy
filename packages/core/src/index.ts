// @eutaxy/core: the pure simulation kernel. See README.md.
export { canonicalJson, type JsonValue } from "./canonical-json.ts";
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
  allFaults,
  decideFault,
  type FaultDecision,
  type FaultKind,
  type FaultPolicy,
  type Schedule,
} from "./faults.ts";
export {
  type AtLeastOnce,
  type AtMostOncePerKey,
  checkInvariant,
  checkInvariants,
  type EffectSelector,
  type EveryRow,
  getPath,
  type Implies,
  type Invariant,
  lastSnapshot,
  matches,
  queryRows,
  type Row,
  type RowCondition,
  recomputePerMessageExpected,
  rowMatches,
  type StateQuery,
  sameViolation,
  selectEffects,
  type Unique,
  type Violation,
} from "./invariants.ts";
export type {
  DeliveryResult,
  EffectPoint,
  EventRef,
  Invocation,
  Platform,
  RunHooks,
} from "./platform.ts";
export { fork, nextFloat, nextInt, nextU32, type PrngState, seedPrng } from "./prng.ts";
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
export { type ShrinkState, shrinkCandidates, shrinkSize } from "./shrink.ts";
export { bytesEqual, utf8Encode } from "./utf8.ts";
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
