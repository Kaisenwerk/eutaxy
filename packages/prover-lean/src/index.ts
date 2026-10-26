// @eutaxy/prover-lean: the first-party TypeScript-subset-to-Lean 4 engine. See README.md.
export { type Emitted, type EmittedTheorem, emitModule, ident, statement, value } from "./emit.ts";
export {
  checkLean,
  diagnostics,
  findLean,
  installHint,
  type LeanDiagnostic,
  type LeanToolchain,
  leanToolchain,
  leanVersion,
} from "./lean.ts";
export {
  engineAssumptions,
  engineName,
  type ModuleProofs,
  type ProofOutcome,
  type PropertyProof,
  type ProveInput,
  prepare,
  proveModule,
} from "./prove.ts";
export {
  type Expr,
  OutsideSubset,
  type RecordType,
  readExpression,
  readSubset,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
} from "./subset.ts";
