/**
 * SpecIR: function specs as plain data. The surface syntax is Lemma
 * (https://github.com/jessealama/lemma-lang, grammar.ebnf and
 * semantics.md); the IR is Eutaxy's own, so engines and the simulator read
 * one shape whatever the annotation looked like. Leaves are opaque
 * TypeScript expressions, kept as written.
 */

/** Lemma's binder domains. */
export type Domain = "int" | "nat" | "number" | "boolean" | "string" | "bigint";

export const domains: readonly Domain[] = ["int", "nat", "number", "boolean", "string", "bigint"];

/**
 * One end of an interval: a numeric literal as written (sign included), or
 * `∞` / `-∞` for either infinity. `[` and `]` include the endpoint.
 */
export interface Endpoint {
  readonly value: string;
  readonly inclusive: boolean;
}

/** A binder's constraint: an interval for numeric domains, a whole-string regex for `string`. */
export type Guard =
  | { readonly kind: "interval"; readonly lower: Endpoint; readonly upper: Endpoint }
  | { readonly kind: "regex"; readonly pattern: string; readonly flags: string };

export interface Binder {
  readonly name: string;
  readonly domain: Domain;
  readonly guard?: Guard;
}

/**
 * A formula over boolean atoms. Atoms and equation sides are TypeScript
 * expressions, verbatim. `and` and `or` are n-ary (both are associative);
 * `implies` keeps Lemma's chain: every segment but the last is an
 * antecedent. An implication at a property's root is not a formula node but
 * the property's preconditions (`Property.requires`).
 */
export type Formula =
  | { readonly kind: "atom"; readonly text: string }
  | {
      readonly kind: "equation";
      readonly left: string;
      readonly right: string;
      /** `≢` rather than `≡`. */
      readonly negated: boolean;
    }
  | { readonly kind: "not"; readonly operand: Formula }
  | { readonly kind: "and" | "or"; readonly operands: readonly Formula[] }
  | {
      readonly kind: "implies";
      readonly antecedents: readonly Formula[];
      readonly consequent: Formula;
    }
  | { readonly kind: "iff"; readonly left: Formula; readonly right: Formula };

/**
 * A universally quantified claim: for every assignment of the binders from
 * their (guarded) domains where every precondition holds, `claim` holds.
 * Assignments failing a precondition are outside the claim.
 */
export interface Property {
  readonly binders: readonly Binder[];
  readonly requires: readonly Formula[];
  readonly claim: Formula;
}

/** An `@ensures{name}` annotation. */
export interface NamedProperty {
  readonly name: string;
  readonly property: Property;
  /** The annotation's property text, as written. */
  readonly text: string;
}

/** The specs on one exported function. */
export interface FunctionSpec {
  readonly name: string;
  /** Parameter names in order; null for a destructured or rest parameter. */
  readonly params: readonly (string | null)[];
  readonly ensures: readonly NamedProperty[];
  /** `@total`: the function terminates on every input. */
  readonly total: boolean;
  /** `@throws`: the function throws (Lemma has not fixed its semantics yet). */
  readonly throws: boolean;
  /** 1-based line of the declaration. */
  readonly line: number;
}

/** A problem with an annotation, located in the module. */
export interface SpecError {
  readonly line: number;
  readonly message: string;
}

/** Every spec in one module, the names it exports, and the annotations that did not parse. */
export interface ModuleSpecs {
  readonly functions: readonly FunctionSpec[];
  readonly exports: readonly string[];
  readonly errors: readonly SpecError[];
}
