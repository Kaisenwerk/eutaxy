import type { SpecType } from "@eutaxy/spec";
import type { TypeNode } from "typescript/ast";
import * as is from "typescript/ast/is";
import { describe, expect, test } from "vitest";
import { withProgram } from "./compiler.ts";
import { OutsideSubset, type SubsetType } from "./subset.ts";
import { SubsetTypes, specTypeOf } from "./types.ts";

const path = "/virtual/types.ts";

/** The type annotation `text` on a parameter, after a module of declarations, read both ways. */
function read(declarations: string, text: string) {
  const source = `${declarations}\nexport function __f(__x: ${text}): void {}\n`;
  return withProgram([{ path, text: source }], ({ checker, file }) => {
    const sf = file(path);
    const decl = sf.statements.find((s) => is.isFunctionDeclaration(s) && s.name?.text === "__f");
    const annotation =
      decl && is.isFunctionDeclaration(decl) ? decl.parameters[0]?.type : undefined;
    if (!annotation) throw new Error("fixture");
    const type = checker.getTypeAtLocation(annotation);
    const types = new SubsetTypes(checker);
    let subset: SubsetType | string;
    try {
      subset = types.of(type, (what) => {
        throw new OutsideSubset(what, 0);
      });
    } catch (err) {
      if (!(err instanceof OutsideSubset)) throw err;
      subset = err.message;
    }
    return { spec: specTypeOf(checker, type), subset, types };
  });
}

const spec = (declarations: string, text: string): SpecType => read(declarations, text).spec;
const subset = (declarations: string, text: string): SubsetType | string =>
  read(declarations, text).subset;

describe("specTypeOf", () => {
  test("primitives, literals, null and undefined", () => {
    expect(spec("", "number")).toEqual({ kind: "number" });
    expect(spec("", "bigint")).toEqual({ kind: "bigint" });
    expect(spec("", '"a"')).toEqual({ kind: "literal", value: "a" });
    expect(spec("", "-1.5")).toEqual({ kind: "literal", value: -1.5 });
    expect(spec("", "true")).toEqual({ kind: "literal", value: true });
    expect(spec("", "boolean")).toEqual({ kind: "boolean" });
    expect(spec("", "null")).toEqual({ kind: "null" });
    expect(spec("", "undefined")).toEqual({ kind: "undefined" });
  });

  test("unions flatten and deduplicate; boolean inside a union folds back; parentheses group", () => {
    expect(spec("", '| "a" | ("b" | "a") | null')).toEqual({
      kind: "union",
      members: [{ kind: "null" }, { kind: "literal", value: "a" }, { kind: "literal", value: "b" }],
    });
    expect(spec("", "boolean | null")).toEqual({
      kind: "union",
      members: [{ kind: "null" }, { kind: "boolean" }],
    });
    expect(spec("", "(number)")).toEqual({ kind: "number" });
  });

  test("interfaces and aliases are records with their names; generic references expand and are named as printed", () => {
    const decls = `
interface Inner { readonly n: number }
type Outer = { readonly a: Inner; b: "x" | "y" };
type Box<T, U = string> = { readonly value: T; readonly tag: U };
type Status = "on" | "off";
`;
    expect(spec(decls, "Outer")).toEqual({
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
    expect(spec(decls, "Box<Status, number>")).toEqual({
      kind: "record",
      name: "Box<Status, number>",
      fields: [
        {
          name: "value",
          type: {
            kind: "union",
            members: [
              { kind: "literal", value: "off" },
              { kind: "literal", value: "on" },
            ],
          },
        },
        { name: "tag", type: { kind: "number" } },
      ],
    });
    // A default type argument is what the compiler fills in.
    const box = spec(decls, "Box<number>");
    expect(box.kind === "record" && box.fields[1]?.type).toEqual({ kind: "string" });
    // An inline type is named as the compiler prints it.
    expect(spec("", "{ readonly ok: boolean }")).toEqual({
      kind: "record",
      name: "{ readonly ok: boolean; }",
      fields: [{ name: "ok", type: { kind: "boolean" } }],
    });
  });

  test("a type declared later in the file, an interface extending another, a type imported from another file", () => {
    const later = spec("type Later = Early | null;\ntype Early = { readonly k: number }", "Later");
    expect(later).toEqual({
      kind: "union",
      members: [
        { kind: "null" },
        { kind: "record", name: "Early", fields: [{ name: "k", type: { kind: "number" } }] },
      ],
    });
    expect(spec("interface A extends B { x: number }\ninterface B { y: string }", "A")).toEqual({
      kind: "record",
      name: "A",
      fields: [
        { name: "x", type: { kind: "number" } },
        { name: "y", type: { kind: "string" } },
      ],
    });
    const imported = withProgram(
      [
        { path: "/virtual/other.ts", text: "export interface Thing { readonly id: string }" },
        {
          path,
          text: 'import type { Thing } from "./other.ts";\nexport function __f(__x: Thing): void {}',
        },
      ],
      ({ checker, file }) => {
        const decl = file(path).statements[1];
        const annotation =
          decl && is.isFunctionDeclaration(decl) ? decl.parameters[0]?.type : undefined;
        if (!annotation) throw new Error("fixture");
        return specTypeOf(checker, checker.getTypeAtLocation(annotation));
      },
    );
    expect(imported).toEqual({
      kind: "record",
      name: "Thing",
      fields: [{ name: "id", type: { kind: "string" } }],
    });
  });

  test("arrays: T[], readonly T[], Array<T>, ReadonlyArray<T>, nested and of unions", () => {
    const num = { kind: "array", element: { kind: "number" } };
    expect(spec("", "number[]")).toEqual(num);
    expect(spec("", "readonly number[]")).toEqual(num);
    expect(spec("", "Array<number>")).toEqual(num);
    expect(spec("", "ReadonlyArray<number>")).toEqual(num);
    expect(spec("", "readonly (readonly number[])[]")).toEqual({ kind: "array", element: num });
    expect(spec("", "(string | null)[]")).toEqual({
      kind: "array",
      element: { kind: "union", members: [{ kind: "null" }, { kind: "string" }] },
    });
    // A module's own type named Array is its own, not the built-in.
    expect(spec("type Array<T> = { readonly first: T }", "Array<number>")).toEqual({
      kind: "record",
      name: "Array<number>",
      fields: [{ name: "first", type: { kind: "number" } }],
    });
  });

  test("what the spec surface does not describe is unknown with its text", () => {
    expect(spec("", "readonly [number, string]")).toEqual({
      kind: "unknown",
      text: "readonly [number, string]",
    });
    expect(spec("", "{ f(): void }")).toEqual({ kind: "unknown", text: "{ f(): void; }" });
    expect(spec("", "{ [k: string]: number }")).toEqual({
      kind: "unknown",
      text: "{ [k: string]: number; }",
    });
    expect(spec("", "Map<string, number>")).toEqual({
      kind: "unknown",
      text: "Map<string, number>",
    });
    expect(spec("", "Nope")).toEqual({ kind: "unknown", text: "Nope" });
    // A type holding itself through an array is cut at the cycle too.
    expect(spec("type R = R[]", "R")).toEqual({
      kind: "array",
      element: { kind: "unknown", text: "R" },
    });
    // A type holding itself is cut at the cycle.
    expect(spec("type R = { next: R | null }", "R")).toEqual({
      kind: "record",
      name: "R",
      fields: [
        {
          name: "next",
          type: { kind: "union", members: [{ kind: "null" }, { kind: "unknown", text: "R" }] },
        },
      ],
    });
    // An optional field admits undefined.
    expect(spec("", "{ a?: number }")).toEqual({
      kind: "record",
      name: "{ a?: number | undefined; }",
      fields: [
        {
          name: "a",
          type: { kind: "union", members: [{ kind: "undefined" }, { kind: "number" }] },
        },
      ],
    });
  });
});

describe("SubsetTypes", () => {
  test("primitives, literal unions as their base, nullable types, lists", () => {
    expect(subset("", "number")).toEqual({ kind: "int" });
    expect(subset("", '"a" | "b"')).toEqual({ kind: "string" });
    expect(subset("", "true")).toEqual({ kind: "bool" });
    expect(subset("", "boolean | null")).toEqual({ kind: "nullable", inner: { kind: "bool" } });
    expect(subset("", "readonly (number | null)[]")).toEqual({
      kind: "list",
      element: { kind: "nullable", inner: { kind: "int" } },
    });
    expect(subset("", "Array<string>")).toEqual({ kind: "list", element: { kind: "string" } });
  });

  test("records are kept by name with their literal-typed fields; a tagged union names its inline members by the tag", () => {
    const decls = `
export interface Challenge { readonly attempts: number; readonly locked: boolean }
export type Outcome =
  | { readonly ok: true; readonly value: Challenge }
  | { readonly ok: false; readonly error: { readonly type: "locked" } };
`;
    const { subset: t, types } = read(decls, "Outcome | null");
    expect(t).toEqual({ kind: "nullable", inner: { kind: "union", name: "Outcome" } });
    expect(types.unions).toEqual([
      {
        name: "Outcome",
        tag: "ok",
        members: [
          { tag: true, record: "Outcome.true" },
          { tag: false, record: "Outcome.false" },
        ],
      },
    ]);
    expect([...types.records.keys()]).toEqual([
      "Challenge",
      "Outcome.true",
      '{ readonly type: "locked"; }',
      "Outcome.false",
    ]);
    expect(types.records.get("Outcome.false")).toEqual({
      name: "Outcome.false",
      unions: ["Outcome"],
      fields: [
        { name: "ok", type: { kind: "bool" }, literal: false },
        { name: "error", type: { kind: "record", name: '{ readonly type: "locked"; }' } },
      ],
    });
  });

  test("a generic alias is read where it is instantiated, named as printed; a record declared on its own keeps its name in a union", () => {
    const decls = `
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export interface Locked { readonly type: "locked" }
export interface Open { readonly type: "open" }
export type Door = Locked | Open;
`;
    const result = read(decls, "Result<number, Locked>");
    expect(result.subset).toEqual({ kind: "union", name: "Result<number, Locked>" });
    expect(result.types.unions[0]?.members).toEqual([
      { tag: true, record: "Result<number, Locked>.true" },
      { tag: false, record: "Result<number, Locked>.false" },
    ]);
    const door = read(decls, "Door");
    expect(door.types.unions[0]).toEqual({
      name: "Door",
      tag: "type",
      members: [
        { tag: "locked", record: "Locked" },
        { tag: "open", record: "Open" },
      ],
    });
    expect(door.types.records.get("Open")).toEqual({
      name: "Open",
      unions: ["Door"],
      fields: [{ name: "type", type: { kind: "string" }, literal: "open" }],
    });
  });

  test("what the subset does not take is refused with the construct named", () => {
    expect(subset("", "undefined")).toBe("undefined in a type (the subset has null)");
    expect(subset("", "number | undefined")).toBe("undefined in a type (the subset has null)");
    expect(subset("", "1 | 2")).toContain("numeric literal type");
    expect(subset("", "bigint")).toContain("bigint");
    expect(subset("", "null")).toContain("null alone");
    expect(subset("", "[number, string]")).toBe("a tuple type");
    expect(subset("", "{ a: number } & { b: number }")).toBe("an intersection type");
    expect(subset("", "() => number")).toBe("a function type");
    expect(subset("", "{ [k: string]: number }")).toBe("an index signature");
    expect(subset("", "{ a?: number }")).toBe(
      "type { a?: number | undefined; } is outside the subset: optional field a",
    );
    expect(subset("", "{ f(): number }")).toContain("a method f");
    expect(subset("", "{ mk: number }")).toContain("takes a name Lean's structures reserve");
    expect(subset("", "number | string")).toContain("a union of several types");
    expect(subset("", "{ a: number } | string")).toBe("a union mixing records with other types");
    expect(subset("", "{ a: number } | { b: number }")).toContain("without a tag");
    expect(subset("type R = { next: R | null }", "R")).toContain("holds itself");
    expect(subset("type R = R[]", "R")).toContain("holds itself");
    expect(subset("", "Nope")).toContain("does not resolve");
    // A field's refusal names the record it is in.
    expect(subset("type P = { inner: { x?: number } }", "P")).toBe(
      "type P is outside the subset: field inner: type { x?: number | undefined; } is outside the subset: optional field x",
    );
  });

  test("a refused union leaves no trace: a member read before it stays a record of its own", () => {
    const decls =
      'export interface A { readonly k: "a"; readonly n: number }\nexport type U = A | { readonly k: "b"; readonly n?: number };';
    const r = withProgram(
      [{ path, text: `${decls}\nexport function __f(__a: A, __u: U): void {}` }],
      ({ checker, file }) => {
        const decl = file(path).statements.find((st) => is.isFunctionDeclaration(st));
        if (!decl || !is.isFunctionDeclaration(decl)) throw new Error("fixture");
        const types = new SubsetTypes(checker);
        const refuse = (what: string): never => {
          throw new OutsideSubset(what, 0);
        };
        const of = (i: number) => {
          const annotation = decl.parameters[i]?.type;
          if (!annotation) throw new Error("fixture");
          return types.of(checker.getTypeAtLocation(annotation), refuse);
        };
        expect(of(0)).toEqual({ kind: "record", name: "A" });
        expect(() => of(1)).toThrow("optional field n");
        return types;
      },
    );
    expect(r.unions).toEqual([]);
    expect([...r.records.keys()]).toEqual(["A"]);
    expect(r.records.get("A")).toEqual({
      name: "A",
      fields: [
        { name: "k", type: { kind: "string" }, literal: "a" },
        { name: "n", type: { kind: "int" } },
      ],
    });
  });

  test("a getter is no stored field: an object with an accessor is refused", () => {
    expect(subset("interface I { get n(): number }", "I")).toContain("accessor n");
    expect(subset("type T = { get n(): number; set n(v: number) }", "T")).toContain("accessor n");
    expect(spec("interface I { get n(): number }", "I")).toEqual({ kind: "unknown", text: "I" });
  });

  test("a refused union takes its nested unions and records back with it", () => {
    const { subset: t, types } = read(
      'type Bad = { kind: "a"; nested: { t: "x" } | { t: "y" } } | { kind: "b"; n?: number };',
      "Bad",
    );
    expect(t).toContain("optional field n");
    expect(types.unions).toEqual([]);
    expect([...types.records.keys()]).toEqual([]);
  });

  test("two inline types of one structure are one record; one name with two structures is refused", () => {
    const same = withProgram(
      [{ path, text: "export function __f(__a: { n: number }, __b: { n: number }): void {}" }],
      ({ checker, file }) => {
        const decl = file(path).statements[0];
        if (!decl || !is.isFunctionDeclaration(decl)) throw new Error("fixture");
        const types = new SubsetTypes(checker);
        const refuse = (what: string): never => {
          throw new OutsideSubset(what, 0);
        };
        for (const p of decl.parameters)
          expect(
            types.of(checker.getTypeAtLocation(p.type as NonNullable<typeof p.type>), refuse),
          ).toEqual({
            kind: "record",
            name: "{ n: number; }",
          });
        return types;
      },
    );
    expect([...same.records.keys()]).toEqual(["{ n: number; }"]);
  });

  test("plain data only: a class instance, an interface over a base that does not resolve, and a type that nests without end are no records", () => {
    // A class is nominal: a plain object of its fields is not an instance.
    const token = "class Token { private brand = 0; id = 0 }";
    expect(spec(token, "Token")).toEqual({ kind: "unknown", text: "Token" });
    expect(subset(token, "Token")).toContain("a class");
    // A class anywhere up an interface's ancestry makes it nominal too.
    const ancestry =
      "class Base { private brand = true }\ninterface Mid extends Base {}\ninterface Leaf extends Mid { id: number }";
    expect(spec(ancestry, "Leaf")).toEqual({ kind: "unknown", text: "Leaf" });
    expect(subset(ancestry, "Leaf")).toContain("class");
    // An interface extending what does not resolve shows only its own fields to the compiler.
    const partial =
      'import type { Base } from "@app/base";\ninterface D extends Base { id: number }';
    expect(spec(partial, "D")).toEqual({ kind: "unknown", text: "D" });
    expect(subset(partial, "D")).toContain("does not resolve");
    // A generic that instantiates itself anew at each level never repeats a type: cut by depth.
    const expanding = "type R<T> = { readonly next: R<T[]> }";
    expect(spec(expanding, "R<number>")).toMatchObject({ kind: "record", name: "R<number>" });
    expect(subset(expanding, "R<number>")).toContain("nested too deep");
  });

  test("a symbol-keyed field is no field of plain data", () => {
    const decls =
      "declare const key: unique symbol;\ninterface R { readonly [key]: number; readonly n: number }";
    expect(spec(decls, "R")).toEqual({ kind: "unknown", text: "R" });
    expect(subset(decls, "R")).toContain("symbol");
  });

  test("two unions of one name from two files are a clash, not one union", () => {
    const r = withProgram(
      [
        {
          path: "/virtual/a.ts",
          text: 'export type Result = { readonly k: "a" } | { readonly k: "b" };',
        },
        {
          path: "/virtual/b.ts",
          text: 'export type Result = { readonly t: "x" } | { readonly t: "y" };',
        },
        {
          path,
          text: 'import type { Result as A } from "./a.ts";\nimport type { Result as B } from "./b.ts";\nexport function __f(__a: A, __b: B): void {}',
        },
      ],
      ({ checker, file }) => {
        const decl = file(path).statements[2];
        if (!decl || !is.isFunctionDeclaration(decl)) throw new Error("fixture");
        const types = new SubsetTypes(checker);
        const refuse = (what: string): never => {
          throw new OutsideSubset(what, 0);
        };
        const of = (i: number) =>
          types.of(
            checker.getTypeAtLocation(decl.parameters[i]?.type as NonNullable<TypeNode>),
            refuse,
          );
        expect(of(0)).toEqual({ kind: "union", name: "Result" });
        expect(() => of(1)).toThrow("two types named Result");
        return types;
      },
    );
    expect(r.unions.map((u) => u.name)).toEqual(["Result"]);
    expect([...r.records.keys()]).toEqual(["Result.a", "Result.b"]);
  });

  test("a record of a name a union holds is a clash too", () => {
    const r = withProgram(
      [
        {
          path: "/virtual/a.ts",
          text: 'export type Result = { readonly k: "a" } | { readonly k: "b" };',
        },
        { path: "/virtual/b.ts", text: "export interface Result { readonly n: number }" },
        {
          path,
          text: 'import type { Result as A } from "./a.ts";\nimport type { Result as B } from "./b.ts";\nexport function __f(__a: A, __b: B): void {}',
        },
      ],
      ({ checker, file }) => {
        const decl = file(path).statements[2];
        if (!decl || !is.isFunctionDeclaration(decl)) throw new Error("fixture");
        const types = new SubsetTypes(checker);
        const refuse = (what: string): never => {
          throw new OutsideSubset(what, 0);
        };
        const of = (i: number) =>
          types.of(
            checker.getTypeAtLocation(decl.parameters[i]?.type as NonNullable<TypeNode>),
            refuse,
          );
        expect(of(0)).toEqual({ kind: "union", name: "Result" });
        expect(() => of(1)).toThrow("two types named Result");
        return types;
      },
    );
    expect([...r.records.keys()]).toEqual(["Result.a", "Result.b"]);
  });

  test("a record may be a member of several unions, and lists them", () => {
    const decls = `
export interface A { readonly t: "a" }
export interface B { readonly t: "b" }
export interface C { readonly t: "c" }
export type U1 = A | B;
export type U2 = A | C;
`;
    const r = withProgram(
      [{ path, text: `${decls}\nexport function __f(__1: U1, __2: U2): void {}` }],
      ({ checker, file }) => {
        const sf = file(path);
        const types = new SubsetTypes(checker);
        const refuse = (what: string): never => {
          throw new OutsideSubset(what, 0);
        };
        const of = (name: string) => {
          const decl = sf.statements.find((s) => is.isFunctionDeclaration(s));
          const param =
            decl && is.isFunctionDeclaration(decl)
              ? decl.parameters.find((p) => is.isIdentifier(p.name) && p.name.text === name)
              : undefined;
          if (!param?.type) throw new Error("fixture");
          return types.of(checker.getTypeAtLocation(param.type), refuse);
        };
        expect(of("__1")).toEqual({ kind: "union", name: "U1" });
        expect(of("__2")).toEqual({ kind: "union", name: "U2" });
        return types;
      },
    );
    expect(r.unions.map((u) => u.name)).toEqual(["U1", "U2"]);
    expect(r.records.get("A")?.unions).toEqual(["U1", "U2"]);
  });
});
