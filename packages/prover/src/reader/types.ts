/**
 * The compiler's types read two ways. `specTypeOf` reads a type into
 * `SpecType` as far as the spec surface describes it (primitives,
 * literals, records, unions, arrays), marking the rest `unknown` with its
 * text: binder domains for the simulator's rungs. `SubsetTypes` reads a
 * type into the subset's own types (integers, booleans, strings, records,
 * nullable types, tagged unions, lists), naming every record and union it
 * meets so the engines can declare them: a declared type by its name, an
 * instantiated generic or an inline object type as the compiler prints
 * it, a union member declared inline by its union and its tag. Both read
 * what the compiler resolved, so a type declared later in the file, in
 * another file, or through a generic alias reads as its structure.
 */

import type { SpecType } from "@eutaxy/spec";
import { SyntaxKind } from "typescript/ast";
import * as is from "typescript/ast/is";
import {
  type Checker,
  SymbolFlags,
  type Type,
  TypeFlags,
  TypeFormatFlags,
  type TypeReference,
} from "typescript/sync";
import type { Field, RecordType, SubsetType, UnionType } from "./subset.ts";

/** Levels of records and lists inside one another a type may hold before it is cut (a generic instantiating itself anew at each level never repeats). */
const maxDepth = 16;

/**
 * Why an object type is not plain data, or undefined when it is: a class
 * (an instance is more than its fields: nominal, with private ones), or an
 * interface over a base the compiler could not resolve (it then shows the
 * interface's own fields alone) or over a class.
 */
export function notPlain(
  checker: Checker,
  type: Type,
  seen: Set<number> = new Set(),
): string | undefined {
  const symbol = type.getSymbol();
  if (!symbol || seen.has(type.id)) return undefined;
  seen.add(type.id);
  if ((symbol.flags & SymbolFlags.Class) !== 0)
    return "a class (an instance is more than a record of its fields)";
  if ((symbol.flags & SymbolFlags.Interface) === 0) return undefined;
  for (const handle of symbol.declarations) {
    if (handle.kind !== SyntaxKind.InterfaceDeclaration) continue;
    const decl = handle.resolve();
    if (!decl || !is.isInterfaceDeclaration(decl)) continue;
    for (const clause of decl.heritageClauses ?? [])
      for (const base of clause.types) {
        const baseType = checker.getTypeAtLocation(base);
        if (baseType.isErrorType()) return `extends ${base.getText()}, which does not resolve`;
        // The whole ancestry: a class anywhere up makes the interface nominal.
        const why = notPlain(checker, baseType, seen);
        if (why !== undefined) return `extends ${base.getText()}: ${why}`;
      }
  }
  return undefined;
}

/** A type as the compiler prints it, in full. */
export function printType(checker: Checker, type: Type): string {
  return checker.typeToString(type, undefined, TypeFormatFlags.NoTruncation);
}

/**
 * The name a record or union goes by: its alias or interface name when
 * declared without type arguments, otherwise the type as the compiler
 * prints it (`Result<true, Locked>`, `{ readonly ok: boolean; }`).
 */
export function nameOfType(checker: Checker, type: Type): string {
  const alias = type.getAliasSymbol();
  if (alias)
    return type.getAliasTypeArguments().length === 0 ? alias.name : printType(checker, type);
  const symbol = type.getSymbol();
  if (
    symbol &&
    (symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class)) !== 0 &&
    !(type.isTypeReference() && checker.getTypeArguments(type).length > 0)
  )
    return symbol.name;
  return printType(checker, type);
}

/** A union's members with `true | false` folded back into `boolean`, which the compiler keeps apart. */
function foldBooleans(members: readonly Type[]): (Type | "boolean")[] {
  const isTrue = (t: Type) => t.isBooleanLiteralType() && t.value === true;
  const isFalse = (t: Type) => t.isBooleanLiteralType() && t.value === false;
  if (!members.some(isTrue) || !members.some(isFalse)) return [...members];
  const out: (Type | "boolean")[] = [];
  let folded = false;
  for (const m of members) {
    if (isTrue(m) || isFalse(m)) {
      if (!folded) out.push("boolean");
      folded = true;
    } else out.push(m);
  }
  return out;
}

/** The members of a union as one type: flattened, deduplicated, one member alone. */
export function unionOf(members: readonly SpecType[]): SpecType {
  const flat = members.flatMap((m) => (m.kind === "union" ? m.members : [m]));
  const seen = new Set<string>();
  const unique = flat.filter((m) => {
    const key = JSON.stringify(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length === 1 ? (unique[0] as SpecType) : { kind: "union", members: unique };
}

/** A type into `SpecType`; what the spec surface does not describe is `unknown` with the type's text. */
export function specTypeOf(
  checker: Checker,
  type: Type,
  seen: ReadonlySet<number> = new Set(),
): SpecType {
  const unknown = (): SpecType => ({ kind: "unknown", text: printType(checker, type) });
  const flags = type.flags;
  if (type.isErrorType()) return unknown();
  if (flags & TypeFlags.Number) return { kind: "number" };
  if (flags & TypeFlags.String) return { kind: "string" };
  if (flags & TypeFlags.Boolean) return { kind: "boolean" };
  if (flags & TypeFlags.BigInt) return { kind: "bigint" };
  if (type.isStringLiteralType() || type.isNumberLiteralType() || type.isBooleanLiteralType())
    return { kind: "literal", value: type.value };
  if (flags & TypeFlags.Null) return { kind: "null" };
  if (flags & (TypeFlags.Undefined | TypeFlags.Void)) return { kind: "undefined" };
  if (type.isUnionType())
    return unionOf(
      foldBooleans(type.getTypes()).map((m) =>
        m === "boolean" ? { kind: "boolean" } : specTypeOf(checker, m, seen),
      ),
    );
  if (!type.isObjectType()) return unknown();
  // A type reaching itself through a field or an element: the cycle is cut with the type's name;
  // one that nests without repeating is cut at a depth.
  if (seen.has(type.id) || seen.size >= maxDepth) return unknown();
  const inner = new Set(seen).add(type.id);
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as TypeReference)[0];
    return element ? { kind: "array", element: specTypeOf(checker, element, inner) } : unknown();
  }
  if (
    type.isTupleType() ||
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0 ||
    type.getIndexInfos().length > 0
  )
    return unknown();
  if (notPlain(checker, type) !== undefined) return unknown();
  const properties = type.getProperties();
  // An object with a method or an accessor is no record of plain data (a Map, a class instance), and
  // neither is one keyed by a symbol (the compiler names it `__@key@…`, which no string names).
  const computed = SymbolFlags.Method | SymbolFlags.GetAccessor | SymbolFlags.SetAccessor;
  if (properties.some((p) => (p.flags & computed) !== 0 || isSymbolKey(p.name))) return unknown();
  const fields = properties.map((p) => ({
    name: p.name,
    type: specTypeOf(checker, checker.getTypeOfSymbol(p), inner),
  }));
  return { kind: "record", name: nameOfType(checker, type), fields };
}

/** Whether a property's name is the compiler's spelling of a symbol key, which no string names. */
const isSymbolKey = (name: string): boolean => name.startsWith("__@");

/** Names a Lean structure declaration generates itself, which a field cannot take. */
const structureNames = new Set([
  "mk",
  "rec",
  "recOn",
  "casesOn",
  "noConfusion",
  "noConfusionType",
  "injEq",
]);

/** `OutsideSubset` at the type being read, by the reader that asked. */
export type Refuse = (what: string) => never;

/**
 * The subset's types read from the compiler's, with every record and
 * union met along the way kept by name, in the order met, for the engines
 * to declare. One type is read once: a second meeting gives the same
 * record, and so does another compiler type of the same name and the
 * same fields (an inline type written twice). A type the subset does not
 * take is refused with the construct named, and a read that is refused
 * leaves nothing behind: whatever it registered on the way is taken back,
 * so no record belongs to a union that was never declared.
 */
export class SubsetTypes {
  readonly records = new Map<string, RecordType>();
  readonly unions: UnionType[] = [];
  private readonly checker: Checker;
  /** By the compiler's type id. */
  private readonly byId = new Map<number, SubsetType>();
  private readonly idOfName = new Map<string, number>();
  /** Types being read now, to refuse a type that holds itself. */
  private readonly reading = new Set<number>();

  constructor(checker: Checker) {
    this.checker = checker;
  }

  /** The subset type of a compiler type, or a refusal, after which nothing of the read remains. */
  of(type: Type, refuse: Refuse): SubsetType {
    const cached = this.byId.get(type.id);
    if (cached) return cached;
    if (this.reading.size > 0) return this.enter(type, refuse);
    // The outermost read of a type: all or nothing.
    const saved = {
      records: new Map(this.records),
      idOfName: new Map(this.idOfName),
      byId: new Map(this.byId),
      unions: this.unions.length,
    };
    try {
      return this.enter(type, refuse);
    } catch (err) {
      this.records.clear();
      for (const [k, v] of saved.records) this.records.set(k, v);
      this.idOfName.clear();
      for (const [k, v] of saved.idOfName) this.idOfName.set(k, v);
      this.byId.clear();
      for (const [k, v] of saved.byId) this.byId.set(k, v);
      this.unions.length = saved.unions;
      throw err;
    }
  }

  /** A type read under the recursion guard. */
  private enter(type: Type, refuse: Refuse): SubsetType {
    // A type reaching itself, through a field or an element, is refused rather than followed.
    if (this.reading.has(type.id))
      return refuse(`${nameOfType(this.checker, type)} holds itself (a recursive type)`);
    if (this.reading.size >= maxDepth)
      return refuse(
        `${nameOfType(this.checker, type)} is nested too deep (more than ${maxDepth} levels)`,
      );
    this.reading.add(type.id);
    try {
      const out = this.read(type, refuse);
      this.byId.set(type.id, out);
      return out;
    } finally {
      this.reading.delete(type.id);
    }
  }

  private read(type: Type, refuse: Refuse): SubsetType {
    const checker = this.checker;
    const text = () => printType(checker, type);
    const flags = type.flags;
    if (type.isErrorType()) return refuse(`type ${text()}, which does not resolve`);
    if (flags & TypeFlags.Number) return { kind: "int" };
    if (flags & (TypeFlags.String | TypeFlags.StringLiteral)) return { kind: "string" };
    if (flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) return { kind: "bool" };
    if (flags & TypeFlags.Null) return refuse("null alone is not a type the subset takes");
    if (flags & (TypeFlags.Undefined | TypeFlags.Void))
      return refuse("undefined in a type (the subset has null)");
    if (flags & TypeFlags.NumberLiteral)
      return refuse(`the numeric literal type ${text()} (the subset has number)`);
    if (flags & TypeFlags.BigInt) return refuse("bigint (the subset has number)");
    if (flags & TypeFlags.TypeParameter) return refuse("type parameters");
    if (type.isUnionType()) return this.union(type, refuse);
    if (type.isIntersectionType()) return refuse("an intersection type");
    if (!type.isObjectType())
      return refuse(
        `type ${text()} (the subset has number, boolean, string, null, and record types, unions and arrays of them)`,
      );
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as TypeReference)[0];
      if (!element) return refuse(`type ${text()}`);
      return { kind: "list", element: this.of(element, refuse) };
    }
    if (type.isTupleType()) return refuse("a tuple type");
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
      return refuse("a function type");
    if (type.getIndexInfos().length > 0) return refuse("an index signature");
    const why = notPlain(checker, type);
    if (why !== undefined) return refuse(`type ${text()} is outside the subset: ${why}`);
    const record = this.record(type, nameOfType(checker, type), refuse);
    return { kind: "record", name: record.name };
  }

  /** A union: `T | null` a nullable, literals their base type, several records a tagged union. */
  private union(type: Type, refuse: Refuse): SubsetType {
    const members = type.isUnionType() ? type.getTypes() : [type];
    if (members.some((m) => (m.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0))
      return refuse("undefined in a type (the subset has null)");
    const nulls = members.filter((m) => (m.flags & TypeFlags.Null) !== 0);
    const rest = members.filter((m) => (m.flags & TypeFlags.Null) === 0);
    const bare = nulls.length === 0 ? type : type.getNonNullableType();
    let base: SubsetType;
    if (rest.length === 0) return refuse("null alone is not a type the subset takes");
    else if (rest.every((m) => (m.flags & (TypeFlags.String | TypeFlags.StringLiteral)) !== 0))
      base = { kind: "string" };
    else if (rest.every((m) => (m.flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) !== 0))
      base = { kind: "bool" };
    else if (rest.length === 1) base = this.of(rest[0] as Type, refuse);
    else if (rest.every((m) => m.isObjectType() && !this.checker.isArrayType(m)))
      base = this.taggedUnion(bare, rest, refuse);
    else if (rest.some((m) => m.isObjectType()))
      return refuse("a union mixing records with other types");
    else if (rest.every((m) => (m.flags & TypeFlags.NumberLiteral) !== 0))
      return refuse(
        `the numeric literal type ${printType(this.checker, type)} (the subset has number)`,
      );
    else
      return refuse(
        `a union of several types (${printType(this.checker, type)}): the subset has a union of literals of one kind, a tagged union of records, and either with null`,
      );
    if (nulls.length === 0) return base;
    if (base.kind === "nullable") return base;
    return { kind: "nullable", inner: base };
  }

  /**
   * A union of records, told apart by a tag: a literal-typed field every
   * member has, holding a different literal in each. Members declared
   * inline are named by the union and their tag (`Outcome.true`); a
   * record declared on its own keeps its name, and may be a member of several unions.
   */
  private taggedUnion(type: Type, members: readonly Type[], refuse: Refuse): SubsetType {
    const cached = this.byId.get(type.id);
    if (cached) return cached;
    const checker = this.checker;
    const name = nameOfType(checker, type);
    // One name, one type: a second union of the name, or a record of it, is a clash.
    const taken = this.idOfName.get(name);
    if (taken !== undefined && taken !== type.id) return refuse(`two types named ${name}`);
    if (taken === undefined && (this.records.has(name) || this.unions.some((u) => u.name === name)))
      return refuse(`two types named ${name}`);
    const literalFields = (m: Type): Map<string, string | boolean> => {
      const out = new Map<string, string | boolean>();
      for (const p of m.getProperties()) {
        const t = checker.getTypeOfSymbol(p);
        if (t.isStringLiteralType() || t.isBooleanLiteralType()) out.set(p.name, t.value);
      }
      return out;
    };
    const literals = members.map(literalFields);
    const tag = [...(literals[0] as Map<string, string | boolean>).keys()].find(
      (field) =>
        literals.every((l) => l.has(field)) &&
        new Set(literals.map((l) => JSON.stringify(l.get(field)))).size === literals.length,
    );
    if (tag === undefined)
      return refuse(
        `${name}: a union of records without a tag (a literal-typed field every member has, different in each)`,
      );
    const isAnonymous = (m: Type) =>
      !m.getAliasSymbol() &&
      ((m.getSymbol()?.flags ?? 0) & (SymbolFlags.Interface | SymbolFlags.Class)) === 0;
    const read = members.map((m, i) => {
      const value = (literals[i] as Map<string, string | boolean>).get(tag) as string | boolean;
      const memberName = isAnonymous(m) ? `${name}.${String(value)}` : nameOfType(checker, m);
      const record = this.record(m, memberName, refuse, name);
      return { tag: value, record: record.name };
    });
    const union: UnionType = { name, tag, members: read };
    this.unions.push(union);
    this.idOfName.set(name, type.id);
    const out: SubsetType = { kind: "union", name };
    this.byId.set(type.id, out);
    return out;
  }

  /** A record under `name`: its fields read, the record kept; a member of `union` when given. */
  private record(type: Type, name: string, refuse: Refuse, union?: string): RecordType {
    let known = this.records.get(name);
    // A union of the name is a clash: one name, one type.
    if (!known && this.unions.some((u) => u.name === name))
      return refuse(`two types named ${name}`);
    if (known && this.idOfName.get(name) !== type.id) {
      // Another compiler type of the same name (an inline type written twice, say) is the same
      // record when it has the same fields, and a clash otherwise.
      const fields = this.fieldsOf(type, name, refuse);
      if (JSON.stringify(fields) !== JSON.stringify(known.fields))
        return refuse(`two types named ${name}`);
      this.byId.set(type.id, { kind: "record", name });
    }
    if (known) {
      if (union !== undefined && !known.unions?.includes(union)) {
        known = { ...known, unions: [...(known.unions ?? []), union] };
        this.records.set(name, known);
      }
      return known;
    }
    const fields = this.fieldsOf(type, name, refuse);
    const record: RecordType = {
      name,
      fields,
      ...(union === undefined ? {} : { unions: [union] }),
    };
    this.records.set(name, record);
    this.idOfName.set(name, type.id);
    this.byId.set(type.id, { kind: "record", name });
    return record;
  }

  /** The fields of a record type, each a stored value the subset takes. */
  private fieldsOf(type: Type, name: string, refuse: Refuse): Field[] {
    // A member read straight from its union is guarded here; one read through `of` already is.
    const guard = !this.reading.has(type.id);
    if (guard) this.reading.add(type.id);
    try {
      const checker = this.checker;
      const fields: Field[] = [];
      const outside: Refuse = (what) => refuse(`type ${name} is outside the subset: ${what}`);
      for (const p of type.getProperties()) {
        if (isSymbolKey(p.name)) return outside("a field keyed by a symbol");
        if ((p.flags & SymbolFlags.Optional) !== 0) return outside(`optional field ${p.name}`);
        if ((p.flags & SymbolFlags.Method) !== 0) return outside(`a method ${p.name}`);
        // A getter computes; a stored field it is not.
        if ((p.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)) !== 0)
          return outside(`an accessor ${p.name}`);
        if (structureNames.has(p.name))
          return outside(`field ${p.name} takes a name Lean's structures reserve`);
        if (p.name === "__proto__")
          return outside("a field named __proto__, which JavaScript treats specially");
        const fieldType = checker.getTypeOfSymbol(p);
        const read = this.of(fieldType, (what) => outside(`field ${p.name}: ${what}`));
        const literal = fieldType.isStringLiteralType()
          ? fieldType.value
          : fieldType.isBooleanLiteralType()
            ? fieldType.value
            : undefined;
        fields.push({ name: p.name, type: read, ...(literal === undefined ? {} : { literal }) });
      }
      return fields;
    } finally {
      if (guard) this.reading.delete(type.id);
    }
  }
}
