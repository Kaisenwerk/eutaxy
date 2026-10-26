// @eutaxy/prover/reader: the pure TypeScript subset, read into a small tree that every engine shares. See ../../README.md.
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
  readExpression,
  readSubset,
  type SubsetFunction,
  type SubsetModule,
  type SubsetType,
  type TypeContext,
  typeOf,
} from "./subset.ts";
