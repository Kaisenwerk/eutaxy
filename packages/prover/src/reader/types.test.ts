import type { SpecType } from "@eutaxy/spec";
import { describe, expect, test } from "vitest";
import { tokenize } from "./tokens.ts";
import { readType, typeDeclarations } from "./types.ts";

const lineOf = (source: string) => (offset: number) => source.slice(0, offset).split("\n").length;

function typeOf(declarations: string, text: string): SpecType {
  const source = `${declarations}\ntype __T = ${text};`;
  const tokens = tokenize(source);
  const decls = typeDeclarations(tokens, lineOf(source));
  const t = decls.get("__T");
  if (!t) throw new Error("fixture");
  return readType(t.tokens, {
    source,
    declarations: decls,
    bindings: new Map(),
    expanding: new Set(),
  });
}

describe("readType", () => {
  test("primitives, literals, null and undefined", () => {
    expect(typeOf("", "number")).toEqual({ kind: "number" });
    expect(typeOf("", "bigint")).toEqual({ kind: "bigint" });
    expect(typeOf("", '"a"')).toEqual({ kind: "literal", value: "a" });
    expect(typeOf("", "-1.5")).toEqual({ kind: "literal", value: -1.5 });
    expect(typeOf("", "true")).toEqual({ kind: "literal", value: true });
    expect(typeOf("", "null")).toEqual({ kind: "null" });
    expect(typeOf("", "undefined")).toEqual({ kind: "undefined" });
  });

  test("unions flatten and deduplicate; a leading bar is allowed; parentheses group", () => {
    expect(typeOf("", '| "a" | ("b" | "a") | null')).toEqual({
      kind: "union",
      members: [{ kind: "literal", value: "a" }, { kind: "literal", value: "b" }, { kind: "null" }],
    });
    expect(typeOf("", "(number)")).toEqual({ kind: "number" });
  });

  test("interfaces and aliases are records with their names; nested and generic references expand", () => {
    const decls = `
interface Inner { readonly n: number }
type Outer = { readonly a: Inner; b: "x" | "y" };
type Box<T, U = string> = { readonly value: T; readonly tag: U };
type Status = "on" | "off";
`;
    expect(typeOf(decls, "Outer")).toEqual({
      kind: "record",
      name: "Outer",
      fields: [
        {
          name: "a",
          type: {
            kind: "record",
            name: "Inner",
            fields: [{ name: "n", type: { kind: "number" } }],
          },
        },
        {
          name: "b",
          type: {
            kind: "union",
            members: [
              { kind: "literal", value: "x" },
              { kind: "literal", value: "y" },
            ],
          },
        },
      ],
    });
    expect(typeOf(decls, "Box<Status, number>")).toEqual({
      kind: "record",
      name: "Box<Status, number>",
      fields: [
        {
          name: "value",
          type: {
            kind: "union",
            members: [
              { kind: "literal", value: "on" },
              { kind: "literal", value: "off" },
            ],
          },
        },
        { name: "tag", type: { kind: "number" } },
      ],
    });
    expect(typeOf(decls, "Status | null")).toEqual({
      kind: "union",
      members: [
        { kind: "literal", value: "on" },
        { kind: "literal", value: "off" },
        { kind: "null" },
      ],
    });
    // A type parameter without an argument (and without a default the reader reads) is unknown, not guessed.
    const box = typeOf(decls, "Box<number>");
    expect(box.kind === "record" && box.fields[1]?.type).toEqual({ kind: "unknown", text: "U" });
  });

  test("a tagged union of records", () => {
    const t = typeOf(
      "",
      '{ readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: { type: "e" } }',
    );
    expect(t.kind).toBe("union");
    if (t.kind !== "union") return;
    expect(t.members.map((m) => m.kind)).toEqual(["record", "record"]);
  });

  test("arrays: T[], readonly T[], Array<T>, ReadonlyArray<T>, nested and of unions", () => {
    const num = { kind: "array", element: { kind: "number" } };
    expect(typeOf("", "number[]")).toEqual(num);
    expect(typeOf("", "readonly number[]")).toEqual(num);
    expect(typeOf("", "Array<number>")).toEqual(num);
    expect(typeOf("", "ReadonlyArray<number>")).toEqual(num);
    expect(typeOf("", "readonly (readonly number[])[]")).toEqual({ kind: "array", element: num });
    expect(typeOf("", "(string | null)[]")).toEqual({
      kind: "array",
      element: { kind: "union", members: [{ kind: "string" }, { kind: "null" }] },
    });
    expect(typeOf("interface E { readonly key: string }", "readonly E[]")).toEqual({
      kind: "array",
      element: { kind: "record", name: "E", fields: [{ name: "key", type: { kind: "string" } }] },
    });
    // `>>` closes two lists at once: the inner one keeps its own `>`.
    expect(typeOf("", "Array<Array<number>>")).toEqual({ kind: "array", element: num });
    expect(typeOf("", "ReadonlyArray<ReadonlyArray<number>>")).toEqual({
      kind: "array",
      element: num,
    });
    expect(typeOf("type Box<T> = { readonly v: T }", "Array<Box<Array<number>>>")).toEqual({
      kind: "array",
      element: { kind: "record", name: "Box<Array<number>>", fields: [{ name: "v", type: num }] },
    });
    // A type imported under the name is that module's, which the reader does not see.
    expect(typeOf('import type { Array } from "./box.ts";', "Array<number>")).toEqual({
      kind: "unknown",
      text: "Array<number>",
    });
    expect(
      typeOf('import { type Thing as ReadonlyArray } from "./t.ts";', "ReadonlyArray<number>"),
    ).toEqual({ kind: "unknown", text: "ReadonlyArray<number>" });
    // A record field may be a read-only array, with or without separators between the fields.
    expect(
      typeOf("interface Input { xs: readonly string[]\n readonly n: number }", "Input"),
    ).toEqual({
      kind: "record",
      name: "Input",
      fields: [
        { name: "xs", type: { kind: "array", element: { kind: "string" } } },
        { name: "n", type: { kind: "number" } },
      ],
    });
    // A class after a statement without a semicolon still declares; an object key named import
    // imports nothing.
    expect(typeOf("const n = 1\nclass Array<T> { value!: T }", "Array<number>")).toMatchObject({
      kind: "unknown",
    });
    expect(typeOf("const handlers = { import: Array };", "Array<number>")).toEqual(num);
    expect(
      typeOf("const flags = { import: true }\ninterface Keep { n: number }", "Keep"),
    ).toMatchObject({ kind: "record" });
    // Wherever the module declares or imports the name, however its statements end, it is not
    // the built-in: a wrong guess must give unknown, never arrays where a class is meant.
    for (const shadow of [
      "const marker = 1!\nclass Array<T> { value!: T }",
      "const marker = 1!\nimport { Array } from './box.ts'",
      "const f = () =>\nclass ReadonlyArray<T> {}",
    ])
      expect(
        typeOf(shadow, shadow.includes("Readonly") ? "ReadonlyArray<number>" : "Array<number>"),
        shadow,
      ).toMatchObject({ kind: "unknown" });
    expect(typeOf('import { Array as Box } from "./box.ts";', "Array<number>")).toEqual(num);
    expect(typeOf('import { type Array as Box } from "./box.ts";', "Array<number>")).toEqual(num);
    // A line break after an operator continues the expression: still a class expression.
    for (const continued of [
      "const Impl =\nclass Input {};",
      "const Impl = new\nclass Input {}();",
    ])
      expect(
        typeOf(`interface Input { value: number }\n${continued}`, "Input"),
        continued,
      ).toMatchObject({
        kind: "record",
      });
    // An interface merged with a class keeps the interface's fields, whichever comes first.
    for (const merged of [
      "interface Point { x: number }\nclass Point {}",
      "class Point {}\ninterface Point { x: number }",
    ])
      expect(typeOf(merged, "Point"), merged).toMatchObject({ kind: "record", name: "Point" });
    // A class expression's name is its own, not the module's.
    expect(
      typeOf("interface Input { value: number }\nconst Impl = class Input {};", "Input"),
    ).toMatchObject({
      kind: "record",
    });
    // So is a class or an enum of the name; an import that binds nothing changes nothing.
    expect(typeOf("class Array<T> { value!: T }", "Array<number>")).toMatchObject({
      kind: "unknown",
    });
    for (const noBinding of [
      'import "./setup.ts"',
      "const u = import.meta.url;",
      'const m = import("./lazy.ts");',
    ])
      expect(typeOf(noBinding, "Array<number>"), noBinding).toEqual(num);
    expect(typeOf('import fs = require("node:fs");', "Array<number>")).toEqual(num);
    // A module's own declaration named Array is its own, not the built-in.
    expect(typeOf("type Array<T> = { readonly first: T }", "Array<number>")).toMatchObject({
      kind: "record",
    });
  });

  test("what the reader does not read is unknown with its text", () => {
    expect(typeOf("", "T[number]")).toEqual({ kind: "unknown", text: "T[number]" });
    expect(typeOf("", "Array<number, string>")).toEqual({
      kind: "unknown",
      text: "Array<number, string>",
    });
    expect(typeOf("", "readonly [number, string]")).toEqual({
      kind: "unknown",
      text: "readonly [number, string]",
    });
    expect(typeOf("", "A & B")).toEqual({ kind: "unknown", text: "A & B" });
    expect(typeOf("", "Map<string, number>")).toEqual({
      kind: "unknown",
      text: "Map<string, number>",
    });
    expect(typeOf("", "ns.T")).toEqual({ kind: "unknown", text: "ns.T" });
    expect(typeOf("", "{ a?: number }")).toEqual({ kind: "unknown", text: "{ a?: number }" });
    expect(typeOf("", "{ f(): void }")).toEqual({ kind: "unknown", text: "{ f(): void }" });
    expect(typeOf("", "{ [k: string]: number }")).toEqual({
      kind: "unknown",
      text: "{ [k: string]: number }",
    });
    expect(typeOf("interface A extends B { x: number }", "A")).toEqual({
      kind: "unknown",
      text: "A",
    });
    expect(typeOf("type R = { next: R | null }", "R")).toEqual({
      kind: "record",
      name: "R",
      fields: [
        {
          name: "next",
          type: { kind: "union", members: [{ kind: "unknown", text: "R" }, { kind: "null" }] },
        },
      ],
    });
    // One unreadable member keeps its own text; the union around it still shows its shape.
    expect(typeOf("", "number | Date")).toEqual({
      kind: "union",
      members: [{ kind: "number" }, { kind: "unknown", text: "Date" }],
    });
  });
});

describe("typeDeclarations", () => {
  test("an alias ends at its semicolon, or at the next declaration on a later line", () => {
    const source =
      "type A = number\nexport type B = { a: A }\ntype C = A | B;\nfunction f() {}\ninterface D { x: C }";
    const decls = typeDeclarations(tokenize(source), lineOf(source));
    expect([...decls.keys()]).toEqual(["A", "B", "C", "D"]);
    expect(decls.get("C")?.tokens.map((t) => t.text)).toEqual(["A", "|", "B"]);
    expect(decls.get("B")?.tokens.map((t) => t.text)).toEqual(["{", "a", ":", "A", "}"]);
  });
});
