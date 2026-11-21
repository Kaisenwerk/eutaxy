/**
 * The subset's tree: its types (`SubsetType`, records, tagged unions),
 * its expressions (`Expr`), and a module as read (`SubsetModule`: the
 * functions the subset takes and, for the others, why not), with what
 * depends on the tree alone: `describe`, `children`, `callees`, the list
 * kinds.
 * Every other module of the reader imports this one, and it imports none
 * of them.
 */

export class OutsideSubset extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

export type SubsetType =
  | { readonly kind: "int" }
  | { readonly kind: "bool" }
  | { readonly kind: "string" }
  | { readonly kind: "record"; readonly name: string }
  /** `T | null`. */
  | { readonly kind: "nullable"; readonly inner: SubsetType }
  /** A tagged union of records declared as a type alias; its members are records of the module. */
  | { readonly kind: "union"; readonly name: string }
  /** The type of the literal `null` itself, which only a nullable type accepts. */
  | { readonly kind: "null" }
  /** `readonly T[]` or `T[]`: a list of values of one type (Lean's `List`). */
  | { readonly kind: "list"; readonly element: SubsetType }
  /** The element type of `[]`, which fits in a list of any type. */
  | { readonly kind: "nothing" };

export interface Field {
  readonly name: string;
  readonly type: SubsetType;
  /** The one value a literal-typed field holds (`ok: true`, `type: "locked"`): a union member's tag. */
  readonly literal?: string | boolean;
}

export interface RecordType {
  readonly name: string;
  readonly fields: readonly Field[];
  /**
   * The tagged unions this record is a member of, in the order they were
   * read: `Err<E>` is one in `Result<A, E>` and in `Result<B, E>`. A member
   * written inline in a union is named `<union>.<tag>` after the first.
   */
  readonly unions?: readonly string[];
}

/** Whether a record is a member of a union. */
export function isMember(record: RecordType | undefined, union: string): boolean {
  return record?.unions?.includes(union) ?? false;
}

/** A tagged union: records told apart by one field, the tag, which holds a different literal in each. */
export interface UnionType {
  readonly name: string;
  readonly tag: string;
  /** The member records, in declaration order, by their tag's value. */
  readonly members: readonly { readonly tag: string | boolean; readonly record: string }[];
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "<"
  | "<="
  | ">"
  | ">="
  | "==="
  | "!=="
  | "&&"
  | "||";

export type Expr =
  | { readonly kind: "int"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "null" }
  | { readonly kind: "var"; readonly name: string }
  /** In `body`, `name` (a nullable in scope) stands for its non-null value: inserted where a null check guards. */
  | { readonly kind: "narrow"; readonly name: string; readonly body: Expr }
  /** In `body`, `name` (a union in scope) is its member `member`: inserted where a test of the union's tag guards. */
  | {
      readonly kind: "narrowTag";
      readonly name: string;
      readonly member: string;
      readonly body: Expr;
    }
  | { readonly kind: "neg"; readonly operand: Expr }
  | { readonly kind: "not"; readonly operand: Expr }
  /** `Number.isInteger(e)`: always true of an integer in the engines' integer model, the real predicate on doubles. */
  | { readonly kind: "isInteger"; readonly operand: Expr }
  /** `Math.floor(e)`: rounding toward negative infinity on doubles; the identity on the integers. */
  | { readonly kind: "floor"; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "cond"; readonly test: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr }
  | { readonly kind: "call"; readonly callee: string; readonly args: readonly Expr[] }
  | { readonly kind: "field"; readonly object: Expr; readonly field: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: string; readonly value: Expr }[];
      /** The type its context gives the literal (a declared return type, a const annotation, a parameter), as the compiler sees it: a record, or the union a member is picked from. */
      readonly type?: SubsetType;
    }
  | {
      readonly kind: "let";
      readonly name: string;
      readonly value: Expr;
      readonly body: Expr;
      /** The `const`'s annotation, when it has one: the binding's type, whatever the initializer's. */
      readonly type?: SubsetType;
    }
  /** `[a, b]`, or `[a, b, ...rest]` with the spread last. `xs.length` is a `field` read on a list. */
  | { readonly kind: "list"; readonly items: readonly Expr[]; readonly rest?: Expr }
  /** `xs.slice(1)`: every element but the first. */
  | { readonly kind: "tail"; readonly list: Expr }
  /** `xs[0] ?? fallback`: the first element, or the fallback for an empty list. */
  | { readonly kind: "headOr"; readonly list: Expr; readonly fallback: Expr }
  /** `xs.map`, `xs.flatMap`, `xs.every` or `xs.some` with `(item, index?) => body`. */
  | {
      readonly kind: "iterate";
      readonly op: "map" | "flatMap" | "every" | "some";
      readonly list: Expr;
      readonly item: string;
      readonly index?: string;
      readonly body: Expr;
    }
  /** `xs.reduce((acc, item) => body, init)`: a left fold. */
  | {
      readonly kind: "fold";
      readonly list: Expr;
      readonly acc: string;
      readonly item: string;
      readonly body: Expr;
      readonly init: Expr;
    };

export interface Param {
  readonly name: string;
  readonly type: SubsetType;
}

export interface SubsetFunction {
  readonly name: string;
  readonly params: readonly Param[];
  readonly returns: SubsetType;
  readonly body: Expr;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** Offset of the `(` opening its parameters: the declaration's identity, as the spec extractor records it. */
  readonly offset: number;
  /**
   * For a recursive function, the list parameter it recurses on (its
   * index): the body tests that list's length against 0 first, and every
   * call to itself, in the other branch, passes that list's slice(1).
   */
  readonly structural?: number;
}

/** A function the subset does not take, and why. */
export interface OutsideFunction {
  readonly name: string;
  readonly line: number;
  readonly message: string;
}

export interface SubsetModule {
  readonly records: readonly RecordType[];
  readonly unions: readonly UnionType[];
  /** The functions in the subset, in source order, callees before callers. */
  readonly functions: readonly SubsetFunction[];
  /** The module's other functions: outside the subset themselves, or calling one that is. */
  readonly outside: readonly OutsideFunction[];
}

/** Whether a string holds a surrogate code unit without its pair: no Lean character corresponds to it. */
export function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** A type, for messages. */
export function describe(t: SubsetType): string {
  switch (t.kind) {
    case "record":
    case "union":
      return t.name;
    case "nullable":
      return `${describe(t.inner)} | null`;
    case "list":
      return t.element.kind === "nullable"
        ? `(${describe(t.element)})[]`
        : `${describe(t.element)}[]`;
    default:
      return t.kind;
  }
}

/** The functions an expression calls. */
export function callees(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return out;
    case "narrow":
    case "narrowTag":
      return callees(e.body, out);
    case "neg":
    case "not":
    case "isInteger":
    case "floor":
      return callees(e.operand, out);
    case "binary":
      callees(e.left, out);
      return callees(e.right, out);
    case "cond":
      callees(e.test, out);
      callees(e.ifTrue, out);
      return callees(e.ifFalse, out);
    case "call":
      out.add(e.callee);
      for (const a of e.args) callees(a, out);
      return out;
    case "field":
      return callees(e.object, out);
    case "record":
      for (const f of e.fields) callees(f.value, out);
      return out;
    case "let":
      callees(e.value, out);
      return callees(e.body, out);
    case "list":
      for (const x of e.items) callees(x, out);
      return e.rest ? callees(e.rest, out) : out;
    case "tail":
      return callees(e.list, out);
    case "headOr":
      callees(e.list, out);
      return callees(e.fallback, out);
    case "iterate":
      callees(e.list, out);
      return callees(e.body, out);
    case "fold":
      callees(e.list, out);
      callees(e.init, out);
      return callees(e.body, out);
  }
}

/** An expression's direct subexpressions. */
export function children(e: Expr): Expr[] {
  switch (e.kind) {
    case "int":
    case "bool":
    case "string":
    case "null":
    case "var":
      return [];
    case "narrow":
    case "narrowTag":
      return [e.body];
    case "neg":
    case "not":
    case "isInteger":
    case "floor":
      return [e.operand];
    case "binary":
      return [e.left, e.right];
    case "cond":
      return [e.test, e.ifTrue, e.ifFalse];
    case "call":
      return [...e.args];
    case "field":
      return [e.object];
    case "record":
      return e.fields.map((f) => f.value);
    case "let":
      return [e.value, e.body];
    case "list":
      return [...e.items, ...(e.rest ? [e.rest] : [])];
    case "tail":
      return [e.list];
    case "headOr":
      return [e.list, e.fallback];
    case "iterate":
      return [e.list, e.body];
    case "fold":
      return [e.list, e.init, e.body];
  }
}

/** An expression only lists bring. */
export type ListExpr = Extract<Expr, { kind: "list" | "tail" | "headOr" | "iterate" | "fold" }>;

/** The expression kinds only lists bring, for an engine that does not take them. */
export const listKinds: ReadonlySet<Expr["kind"]> = new Set<ListExpr["kind"]>([
  "list",
  "tail",
  "headOr",
  "iterate",
  "fold",
]);

/** Whether an expression is one only lists bring (a type guard over `listKinds`). */
export const isListExpr = (e: Expr): e is ListExpr => listKinds.has(e.kind);
