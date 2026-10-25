// @eutaxy/prover: the spec ladder. See README.md.
export {
  AtomNotBoolean,
  type CheckedInput,
  checkedRung,
  type Evaluation,
  endpointBigInt,
  evaluate,
  inDomain,
  lemmaBool,
  lemmaUnresolved,
  markerVerdicts,
  render,
  UnresolvedName,
} from "./checked.ts";
export { CannotGenerate, generate, regexAlphabet, shrinkCandidates } from "./generate.ts";
export {
  checkSpecModule,
  type LadderOptions,
  type ModulePredicates,
  specLadder,
} from "./ladder.ts";
export { type TestedInput, type TestedOptions, testedRung } from "./tested.ts";
