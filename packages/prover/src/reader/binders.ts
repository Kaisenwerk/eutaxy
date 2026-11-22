/**
 * A spec's binder type read into the subset's type, once for every
 * engine: `number`, `boolean` and `string` to their own, a literal to its
 * primitive, a union of string literals to a string, a declared record to
 * the module's record of that name, `T | null` to the nullable type over
 * `T`, a union of records to the one declared union whose members match,
 * an array to a list. What an engine does not take is its `BinderRule`:
 * it names the reason, and the binder is refused with it where the engine
 * would have refused it itself, so a user reads the engine's own words.
 * Bigint, `undefined` and what the spec reader could not read are outside
 * for every engine.
 */

import { describeType, type SpecType } from "@eutaxy/spec";
import {
  OutsideSubset,
  type RecordType,
  type SubsetModule,
  type SubsetType,
  type UnionType,
} from "./tree.ts";

/**
 * What an engine does not take of binder types, each with why (the text
 * after `binder <name> over <type>: `). Absent: the engine takes it.
 */
export interface BinderRule {
  /** A union with `null` or `undefined` among its members. Checked before `union`. */
  readonly nullable?: string;
  /** Any union other than one of string literals, which every engine with this rule still reads as a string. */
  readonly union?: string;
  /** An array. */
  readonly array?: string;
}

const fail: (message: string) => never = (message) => {
  throw new OutsideSubset(message, 0);
};

/** The subset type a binder ranges over under an engine's rule, or `OutsideSubset` with why. */
export function readBinderType(
  name: string,
  t: SpecType,
  module: SubsetModule,
  rule: BinderRule,
): SubsetType {
  const over = `binder ${name} over ${describeType(t)}`;
  switch (t.kind) {
    case "number":
      return { kind: "int" };
    case "boolean":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "literal":
      if (typeof t.value === "string") return { kind: "string" };
      if (typeof t.value === "boolean") return { kind: "bool" };
      return { kind: "int" };
    case "bigint":
      // A BigInt passed to a function over number throws on the first mixed operation in JavaScript.
      return fail(`binder ${name} over bigint: the subset has no bigint`);
    case "union": {
      const strings = (ms: readonly SpecType[]): boolean =>
        ms.every((m) => m.kind === "literal" && typeof m.value === "string");
      if (rule.union !== undefined) {
        // An engine that takes no union still takes a union of string literals, as a string.
        if (strings(t.members)) return { kind: "string" };
        if (
          rule.nullable !== undefined &&
          t.members.some((m) => m.kind === "null" || m.kind === "undefined")
        )
          return fail(`${over}: ${rule.nullable}`);
        return fail(`${over}: ${rule.union}`);
      }
      const nulls = t.members.filter((m) => m.kind === "null");
      const undefineds = t.members.some((m) => m.kind === "undefined");
      // An engine that takes no nullable type says so for `undefined` as for `null`.
      if (rule.nullable !== undefined && (nulls.length > 0 || undefineds))
        return fail(`${over}: ${rule.nullable}`);
      if (undefineds) return fail(`${over}: undefined is not in the subset (null is)`);
      const rest = t.members.filter((m) => m.kind !== "null");
      let inner: SubsetType;
      if (strings(rest)) inner = { kind: "string" };
      else if (rest.every((m) => m.kind === "literal" && typeof m.value === "boolean"))
        inner = { kind: "bool" };
      else if (rest.length === 1) inner = readBinderType(name, rest[0] as SpecType, module, rule);
      else if (rest.every((m) => m.kind === "record")) {
        const union = findUnion(
          rest as readonly Extract<SpecType, { kind: "record" }>[],
          module,
          rule,
        );
        if (!union)
          return fail(`${over}: no one union the module declares has exactly these members`);
        inner = { kind: "union", name: union.name };
      } else return fail(`${over}: a union the subset does not read`);
      return nulls.length > 0 ? { kind: "nullable", inner } : inner;
    }
    case "record":
      if (t.name !== undefined && module.records.some((r) => r.name === t.name))
        return { kind: "record", name: t.name };
      return fail(
        `${over}: ${t.name === undefined ? "an inline record type" : `record type ${t.name} is outside the subset`}`,
      );
    case "null":
    case "undefined":
      return fail(`binder ${name} over ${t.kind}`);
    case "array":
      if (rule.array !== undefined) return fail(`${over}: ${rule.array}`);
      return { kind: "list", element: readBinderType(name, t.element, module, rule) };
    case "unknown":
      return fail(`binder ${name} over ${t.text}, which the reader could not read`);
  }
}

/**
 * The one declared union these member types are, compared field by field
 * and type by type: a field holding one literal is that literal in the
 * union's member, a union of literals is a field of no literal, and
 * everything else reads to the field's own type. A record may be a member
 * of several unions, so tags and field names alone could name the wrong
 * one; when more than one union fits, none is chosen.
 */
function findUnion(
  members: readonly Extract<SpecType, { kind: "record" }>[],
  module: SubsetModule,
  rule: BinderRule,
): UnionType | undefined {
  const recordOf = (name: string) => module.records.find((r) => r.name === name);
  // A nested record is compared by its fields, not its name: the spec reader and the subset reader
  // may name one inline type differently (`Extract<U, …>` against `U.a`).
  const recordFits = (sm: Extract<SpecType, { kind: "record" }>, rec: RecordType): boolean =>
    sm.fields.length === rec.fields.length &&
    rec.fields.every((f) => {
      const sf = sm.fields.find((x) => x.name === f.name);
      return sf !== undefined && fieldFits(sf.type, f);
    });
  const typeFits = (sf: SpecType, t: SubsetType): boolean => {
    if (t.kind === "record") {
      const rec = recordOf(t.name);
      return sf.kind === "record" && rec !== undefined && recordFits(sf, rec);
    }
    if (t.kind === "nullable" && sf.kind === "union" && sf.members.some((m) => m.kind === "null")) {
      const rest = sf.members.filter((m) => m.kind !== "null");
      const inner: SpecType =
        rest.length === 1 ? (rest[0] as SpecType) : { kind: "union", members: rest };
      return typeFits(inner, t.inner);
    }
    if (t.kind === "union") {
      const u = module.unions.find((x) => x.name === t.name);
      if (!u || sf.kind !== "union" || sf.members.length !== u.members.length) return false;
      return u.members.every((m) => {
        const rec = recordOf(m.record);
        return (
          rec !== undefined && sf.members.some((sm) => sm.kind === "record" && recordFits(sm, rec))
        );
      });
    }
    try {
      return JSON.stringify(readBinderType("field", sf, module, rule)) === JSON.stringify(t);
    } catch (err) {
      if (err instanceof OutsideSubset) return false;
      throw err;
    }
  };
  function fieldFits(sf: SpecType, f: RecordType["fields"][number]): boolean {
    if (f.literal !== undefined) return sf.kind === "literal" && sf.value === f.literal;
    if (sf.kind === "literal") return false;
    return typeFits(sf, f.type);
  }
  const fitting = module.unions.filter((u) => {
    if (u.members.length !== members.length) return false;
    return u.members.every((m) => {
      const rec = recordOf(m.record);
      return rec !== undefined && members.some((sm) => recordFits(sm, rec));
    });
  });
  return fitting.length === 1 ? fitting[0] : undefined;
}
