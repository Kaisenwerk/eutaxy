// @eutaxy/prover/reader: modules and spec files read into SpecIR, and the pure TypeScript subset read into the tree every engine shares, through the TypeScript compiler's API. See ../../README.md.
export { type BinderRule, readBinderType } from "./binders.ts";
export { closeCompiler } from "./compiler.ts";
export {
  type EngineModule,
  type EngineRestriction,
  engineGap,
  outsideProofs,
  readForEngine,
} from "./engine.ts";
export { insertNarrows, narrowsOf, tagNarrowsOf } from "./narrowing.ts";
export { builtinsAssumption } from "./rebinding.ts";
export { renameVars } from "./rename.ts";
export { restrictModule } from "./restrict.ts";
export { hintsOf, type ReadSpecsInput, readSpecs } from "./specs.ts";
export {
  type ReadSubsetOptions,
  readArrowBody,
  readExpression,
  readSubset,
} from "./subset.ts";
export {
  type BinaryOp,
  children,
  describe,
  type Expr,
  type Field,
  hasLoneSurrogate,
  isListExpr,
  type ListExpr,
  listKinds,
  type OutsideFunction,
  OutsideSubset,
  type Param,
  type RecordType,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type UnionType,
} from "./tree.ts";
export { type CalleeSignature, fits, type TypeContext, typeOf } from "./typing.ts";
