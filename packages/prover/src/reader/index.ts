// @eutaxy/prover/reader: modules and spec files read into SpecIR, and the pure TypeScript subset read into the tree every engine shares. See ../../README.md.
export { hintsOf, type ReadSpecsInput, readSpecs } from "./specs.ts";
export {
  type BinaryOp,
  type CalleeSignature,
  type Declaration,
  type Declared,
  describe,
  type Expr,
  type Field,
  fits,
  hasLoneSurrogate,
  insertNarrows,
  narrowsOf,
  type OutsideFunction,
  OutsideSubset,
  type Param,
  type RecordType,
  readArrowBody,
  readExpression,
  readSubset,
  renameVars,
  restrictModule,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
  type UnionType,
} from "./subset.ts";
export {
  type Token,
  TokenizeError,
  type TokenKind,
  templateSubstitutions,
  tokenize,
} from "./tokens.ts";
export { readType, type TypeDeclaration, type TypeEnv, typeDeclarations, union } from "./types.ts";
