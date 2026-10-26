/**
 * SpecIR: function specs as plain data. The surface is TypeScript (a spec
 * file beside the module, `forall(f, { when, ensures })` and `total(f)`
 * from `eutaxy/spec`); the IR is Eutaxy's own, so the simulator's rungs
 * and every engine read one shape. Binder domains are the function's
 * parameter types, read from its declaration; the precondition and the
 * claim are kept as the arrow functions' text, read by each engine into
 * its own tree, and evaluated as code by the simulator's rungs.
 */

/** A TypeScript type as far as the reader can read it; `unknown` carries what it could not. */
export type SpecType =
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "string" }
  | { readonly kind: "bigint" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "null" }
  | { readonly kind: "undefined" }
  | {
      readonly kind: "record";
      /** The declared name, when the type is an `interface` or a `type` alias rather than inline. */
      readonly name?: string;
      readonly fields: readonly Field[];
    }
  | { readonly kind: "union"; readonly members: readonly SpecType[] }
  | { readonly kind: "unknown"; readonly text: string };

export interface Field {
  readonly name: string;
  readonly type: SpecType;
}

/** One end of a numeric range: the literal as written (sign included). `[` and `]` include the endpoint. */
export interface Endpoint {
  readonly value: string;
  readonly inclusive: boolean;
}

/**
 * What the precondition says about one binder on its own, read from its
 * conjuncts: `Number.isInteger(n)`, `0 <= n`, `n < 5`, `/^a+$/.test(s)`.
 * Draws are steered by it; the precondition itself still has the last word.
 */
export interface Hint {
  readonly integer?: true;
  readonly lower?: Endpoint;
  readonly upper?: Endpoint;
  readonly regex?: { readonly pattern: string; readonly flags: string };
}

/** A parameter of the function under spec. */
export interface Param {
  /** Null for a destructured or rest parameter. */
  readonly name: string | null;
  readonly type: SpecType;
}

/** A quantified variable: a parameter, under the name the claim gives it. */
export interface Binder {
  readonly name: string;
  readonly type: SpecType;
  readonly hint?: Hint;
}

/** An arrow function from the spec file, as written. */
export interface Arrow {
  /** Parameter names in order; null for a destructured one. */
  readonly params: readonly (string | null)[];
  /** The body's source text: an expression, or the statements between the braces when `block`. */
  readonly body: string;
  readonly block: boolean;
  /** 1-based line of the arrow in the spec file. */
  readonly line: number;
}

/**
 * One exported spec: `forall(f, { when, ensures })`, a universally
 * quantified claim over `f`'s parameters where the precondition holds, or
 * `total(f)`, that `f` terminates on every input.
 */
export interface Property {
  /** The export's name in the spec file. */
  readonly name: string;
  readonly kind: "forall" | "total";
  /** The parameters, named as `ensures` names them (the function's own names past its arity). */
  readonly binders: readonly Binder[];
  readonly when?: Arrow;
  readonly ensures?: Arrow;
  /**
   * The module's functions the spec file imports, by the local name the
   * arrows use: a claim's free names resolve here, never in the module.
   */
  readonly imports: readonly { readonly local: string; readonly fn: string }[];
  /** The claim as written, for reports. */
  readonly text: string;
  /** 1-based line of the export in the spec file. */
  readonly line: number;
}

/** The specs on one exported function. */
export interface FunctionSpec {
  readonly name: string;
  readonly params: readonly Param[];
  readonly properties: readonly Property[];
  /** 1-based line of the declaration in the module. */
  readonly line: number;
  /** Offset in the module's source of the `(` opening the parameters: the declaration's identity. */
  readonly offset: number;
}

/** A problem with a spec, located in the spec file (or the module when `inModule`). */
export interface SpecError {
  readonly line: number;
  readonly message: string;
  readonly inModule?: true;
}

/** Every spec of one module, and what did not read. */
export interface ModuleSpecs {
  readonly functions: readonly FunctionSpec[];
  readonly errors: readonly SpecError[];
}

/** A type, for messages. */
export function describeType(t: SpecType): string {
  switch (t.kind) {
    case "number":
    case "boolean":
    case "string":
    case "bigint":
    case "null":
    case "undefined":
      return t.kind;
    case "literal":
      return typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value);
    case "record":
      return (
        t.name ?? `{ ${t.fields.map((f) => `${f.name}: ${describeType(f.type)}`).join("; ")} }`
      );
    case "union":
      return t.members.map(describeType).join(" | ");
    case "unknown":
      return t.text;
  }
}
