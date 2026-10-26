// @eutaxy/prover: the spec ladder. See README.md. The reader lives under `@eutaxy/prover/reader`.
export {
  type CheckedInput,
  checkedRung,
  type Evaluation,
  evaluate,
  malformedReason,
  type PredicateOutcome,
  render,
} from "./checked.ts";
export {
  CannotGenerate,
  conforms,
  endpointBigInt,
  endpointNumber,
  generate,
  generateAssignment,
  generateOf,
  inDomain,
  integerBound,
  regexAlphabet,
  shrinkCandidates,
} from "./generate.ts";
export { checkSpecModule, type LadderOptions, specLadder } from "./ladder.ts";
export {
  aggregate,
  type EngineId,
  type EngineReport,
  type ModuleProofs,
  type ProofOutcome,
  type PropertyProof,
  type ProveInput,
  type Prover,
} from "./provers.ts";
export { type TestedInput, type TestedOptions, testedRung } from "./tested.ts";
