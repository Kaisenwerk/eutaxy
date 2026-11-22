/**
 * A spec's binder type read into the subset's type under an engine's rule
 * (`readBinderType`): what every engine reads alike, and what each kind of
 * rule refuses, in the engine's own words.
 */
import { describeType, type SpecType } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { type BinderRule, readBinderType } from "./binders.ts";
import { readSubset } from "./subset.ts";
import { OutsideSubset } from "./tree.ts";

const source = [
  "export interface P { readonly x: number; readonly name: string }",
  "export type A = { readonly tag: 'a'; readonly n: number };",
  "export type B = { readonly tag: 'b'; readonly s: string };",
  "export type U = A | B;",
  "export type C = { readonly tag: 'c'; readonly xs: readonly number[] };",
  "export type W = A | C;",
  "export function f(p: P, u: U, xs: readonly number[], m: number | null): number { return p.x; }",
].join("\n");
const module = readSubset(source, ["f"]);

const prim = (kind: string): SpecType => ({ kind }) as SpecType;
const lit = (value: string | number | boolean): SpecType =>
  ({ kind: "literal", value }) as SpecType;
const union = (...members: SpecType[]): SpecType => ({ kind: "union", members }) as SpecType;
const arr = (element: SpecType): SpecType => ({ kind: "array", element }) as SpecType;
const rec = (name: string | undefined, fields: [string, SpecType][]): SpecType =>
  ({
    kind: "record",
    ...(name === undefined ? {} : { name }),
    fields: fields.map(([n, type]) => ({ name: n, type })),
  }) as unknown as SpecType;
const A = rec("A", [
  ["tag", lit("a")],
  ["n", prim("number")],
]);
const B = rec("B", [
  ["tag", lit("b")],
  ["s", prim("string")],
]);
const C = rec("C", [
  ["tag", lit("c")],
  ["xs", arr(prim("number"))],
]);

/** An engine that takes everything, one that takes no array, and one that takes neither nullable types nor unions. */
const all: BinderRule = {};
const noArrays: BinderRule = { array: "no arrays here" };
const noUnions: BinderRule = { nullable: "no nullable types here", union: "no unions here" };

const read = (t: SpecType, rule: BinderRule): string => {
  try {
    return JSON.stringify(readBinderType("b", t, module, rule));
  } catch (err) {
    if (!(err instanceof OutsideSubset)) throw err;
    return `outside: ${err.message}`;
  }
};

describe("readBinderType", () => {
  test("what every engine reads alike: primitives, literals, a declared record, a union of string literals", () => {
    for (const rule of [all, noArrays, noUnions]) {
      expect(read(prim("number"), rule)).toBe('{"kind":"int"}');
      expect(read(prim("boolean"), rule)).toBe('{"kind":"bool"}');
      expect(read(prim("string"), rule)).toBe('{"kind":"string"}');
      expect(read(lit(3), rule)).toBe('{"kind":"int"}');
      expect(read(lit(true), rule)).toBe('{"kind":"bool"}');
      expect(read(lit("a"), rule)).toBe('{"kind":"string"}');
      expect(read(rec("P", []), rule)).toBe('{"kind":"record","name":"P"}');
      expect(read(union(lit("a"), lit("b")), rule)).toBe('{"kind":"string"}');
    }
  });

  test("what no engine takes: bigint, undefined, an inline or unknown record, and what the spec reader could not read", () => {
    for (const rule of [all, noArrays, noUnions]) {
      expect(read(prim("bigint"), rule)).toBe(
        "outside: binder b over bigint: the subset has no bigint",
      );
      expect(read(prim("undefined"), rule)).toBe("outside: binder b over undefined");
      expect(read(prim("null"), rule)).toBe("outside: binder b over null");
      expect(read(rec(undefined, [["x", prim("number")]]), rule)).toMatch(
        /^outside: binder b over .*: an inline record type$/,
      );
      expect(read(rec("Nope", []), rule)).toMatch(
        /^outside: binder b over .*: record type Nope is outside the subset$/,
      );
      expect(read({ kind: "unknown", text: "Map<string, number>" } as SpecType, rule)).toBe(
        "outside: binder b over Map<string, number>, which the reader could not read",
      );
    }
  });

  test("an engine with no rule reads nullable types, the declared union its members are, and lists", () => {
    expect(read(union(prim("number"), prim("null")), all)).toBe(
      '{"kind":"nullable","inner":{"kind":"int"}}',
    );
    expect(read(union(B, A), all)).toBe('{"kind":"union","name":"U"}');
    expect(read(union(A, B, prim("null")), all)).toBe(
      '{"kind":"nullable","inner":{"kind":"union","name":"U"}}',
    );
    expect(read(union(lit(true), lit(false)), all)).toBe('{"kind":"bool"}');
    expect(read(union(lit(true), lit(false), prim("null")), all)).toBe(
      '{"kind":"nullable","inner":{"kind":"bool"}}',
    );
    expect(read(union(A, C), all)).toBe('{"kind":"union","name":"W"}');
    // A member with one field more than the declared one is not that member.
    const wider = rec("A", [
      ["tag", lit("a")],
      ["n", prim("number")],
      ["extra", prim("number")],
    ]);
    expect(read(union(wider, B), all)).toMatch(
      /: no one union the module declares has exactly these members$/,
    );
    expect(read(arr(arr(prim("number"))), all)).toBe(
      '{"kind":"list","element":{"kind":"list","element":{"kind":"int"}}}',
    );
    expect(read(union(prim("number"), prim("undefined")), all)).toMatch(
      /: undefined is not in the subset \(null is\)$/,
    );
    expect(read(union(A, rec("P", [])), all)).toMatch(
      /: no one union the module declares has exactly these members$/,
    );
    expect(read(union(prim("number"), prim("string")), all)).toMatch(
      /: a union the subset does not read$/,
    );
  });

  test("a refusal names the binder and its type as the spec file wrote it", () => {
    const xs = arr(prim("number"));
    expect(read(xs, noArrays)).toBe(`outside: binder b over ${describeType(xs)}: no arrays here`);
    const maybe = union(prim("number"), prim("null"));
    expect(read(maybe, noUnions)).toBe(
      `outside: binder b over ${describeType(maybe)}: no nullable types here`,
    );
    expect(describeType(xs)).not.toBe("array");
  });

  test("a rule against arrays refuses one at any depth, with the engine's reason", () => {
    expect(read(arr(prim("number")), noArrays)).toMatch(
      /^outside: binder b over .*: no arrays here$/,
    );
    // Inside a union's member too: a member holding an array is no member the engine can name.
    expect(read(union(A, C), noArrays)).toMatch(
      /: no one union the module declares has exactly these members$/,
    );
    expect(read(union(arr(prim("number")), prim("null")), noArrays)).toMatch(/: no arrays here$/);
    expect(read(union(prim("number"), prim("null")), noArrays)).toBe(
      '{"kind":"nullable","inner":{"kind":"int"}}',
    );
  });

  test("a rule against unions refuses a nullable type first, then any other union, and still reads lists", () => {
    expect(read(union(prim("number"), prim("null")), noUnions)).toMatch(
      /: no nullable types here$/,
    );
    expect(read(union(prim("number"), prim("undefined")), noUnions)).toMatch(
      /: no nullable types here$/,
    );
    expect(read(union(A, B), noUnions)).toMatch(/: no unions here$/);
    expect(read(union(lit(true), lit(false)), noUnions)).toMatch(/: no unions here$/);
    expect(read(arr(prim("number")), noUnions)).toBe('{"kind":"list","element":{"kind":"int"}}');
    expect(read(arr(union(A, B)), noUnions)).toMatch(/: no unions here$/);
  });

  test("a rule against nullable types alone still reads the other unions", () => {
    const noNulls: BinderRule = { nullable: "no nullable types here" };
    expect(read(union(A, B, prim("null")), noNulls)).toMatch(/: no nullable types here$/);
    expect(read(union(prim("number"), prim("undefined")), noNulls)).toMatch(
      /: no nullable types here$/,
    );
    expect(read(union(A, B), noNulls)).toBe('{"kind":"union","name":"U"}');
  });
});
