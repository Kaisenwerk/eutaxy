// @eutaxy/spec: SpecIR, and the combinators a spec file writes. See README.md.
export {
  type Fn,
  type Forall,
  forall,
  isSpec,
  type Spec,
  type Total,
  total,
} from "./combinators.ts";
export {
  type Arrow,
  type Binder,
  describeType,
  type Endpoint,
  type Field,
  type FunctionSpec,
  type Hint,
  type ModuleSpecs,
  type Param,
  type Property,
  type SpecError,
  type SpecType,
} from "./ir.ts";
