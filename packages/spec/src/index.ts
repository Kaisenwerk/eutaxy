// @eutaxy/spec: SpecIR, and Lemma annotations parsed into it and printed back. See README.md.
export { extractSpecs } from "./extract.ts";
export {
  type Binder,
  type Domain,
  domains,
  type Endpoint,
  type Formula,
  type FunctionSpec,
  type Guard,
  type ModuleSpecs,
  type NamedProperty,
  type Property,
  type SpecError,
} from "./ir.ts";
export { endpointNumber, LemmaSyntaxError, parseProperty } from "./parse.ts";
export {
  freeNames,
  type PredicateHelpers,
  type PredicateOutcome,
  predicateSource,
} from "./predicate.ts";
export { printFormula, printProperty } from "./print.ts";
export {
  type Token,
  TokenizeError,
  type TokenKind,
  templateSubstitutions,
  tokenize,
} from "./tokens.ts";
