// @eutaxy/prover/reader: modules and spec files read into SpecIR, and the pure TypeScript subset read into the tree every engine shares. See ../../README.md.
export { hintsOf, type ReadSpecsInput, readSpecs } from "./specs.ts";
export {
  type BinaryOp,
  type CalleeSignature,
  type Expr,
  type Field,
  hasLoneSurrogate,
  type OutsideFunction,
  OutsideSubset,
  type Param,
  type RecordType,
  readArrowBody,
  readExpression,
  readSubset,
  renameVars,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
} from "./subset.ts";
export {
  type Token,
  TokenizeError,
  type TokenKind,
  templateSubstitutions,
  tokenize,
} from "./tokens.ts";
export { readType, type TypeDeclaration, type TypeEnv, typeDeclarations, union } from "./types.ts";
