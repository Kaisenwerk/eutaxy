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

  test("what the reader does not read is unknown with its text", () => {
    expect(typeOf("", "number[]")).toEqual({ kind: "unknown", text: "number[]" });
    expect(typeOf("", "readonly string[]")).toEqual({ kind: "unknown", text: "readonly string[]" });
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
